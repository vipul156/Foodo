import mongoose from "mongoose";
import { AuthRequest } from "../middlewares/isAuth.js";
import { tryCatch } from "../middlewares/trycatch.js";
import { Address } from "../models/Address.js";
import { Order } from "../models/Order.js";
import { Cart } from "../models/Cart.js";
import { Restaurant } from "../models/Restaurant.js";
import { MenuItem, IMenuItem } from "../models/MenuItem.js";
import http from "../config/http.js";
import { publishEvent } from "../config/order.publisher.js";
import { publishRealtimeEvent } from "../config/realtime.publisher.js";
import { deliveryDistanceKm } from "../lib/distance.js";

// Fire-and-forget realtime notification — published onto the RabbitMQ
// fanout exchange the realtime service owns. The order hot path no longer
// makes HTTP calls to the socket tier: no timeouts, no socket exhaustion,
// and a realtime outage only delays UI updates, never the order API.
function notifyRealtime(event: string, room: string, payload: unknown) {
  publishRealtimeEvent(event, room, payload);
}

// Fire-and-forget rider release — frees the rider when their assigned
// order is cancelled so they can go online and take new orders again.
function releaseRider(riderId: unknown) {
  if (!riderId) return;
  http
    .put(
      `${process.env.RIDER_SERVICE_URL}/api/rider/release/internal`,
      { riderId },
      { headers: { "x-internal-key": process.env.INTERNAL_SERVICE_KEY } },
    )
    .catch((err) => console.error("Rider release failed:", err?.message));
}

export const createOrder = tryCatch(async (req: AuthRequest, res) => {
  if (!req.user) {
    throw new Error("User not found");
  }

  // NOTE: `distance` is deliberately NOT accepted from the body — the
  // client used to send it, and it directly sets the rider's payout
  // (riderAmount = ceil(distance) * 17). A malicious client could mint
  // arbitrarily large payouts. Distance is computed server-side from
  // the two coordinate pairs we already store.
  const { addressId, paymentMethod } = req.body;

  if (!paymentMethod) {
    throw new Error("Payment method is required");
  }

  if (!addressId) {
    throw new Error("Address is required");
  }

  const address = await Address.findOne({ _id: addressId, userId: req.user._id });

  if (!address) {
    throw new Error("Address not found");
  }

  const cartItems = await Cart.find({ userId: req.user._id })
    .populate<{ itemId: IMenuItem }>("itemId")
    .populate("restaurantId");

  if (cartItems.length === 0) {
    throw new Error("Cart is empty");
  }

  const firstCartItem = cartItems[0];

  if (!firstCartItem?.restaurantId) {
    throw new Error("Restaurant not found");
  }

  const restaurantId = firstCartItem.restaurantId._id;

  const restaurant = await Restaurant.findById(restaurantId);

  if (!restaurant) {
    throw new Error("No restaurant with this id");
  }

  if (!restaurant.isOpen) {
    throw new Error("Restaurant is closed");
  }

  let subtotal = 0;
  const orderItems = cartItems.map((cart) => {
    const item = cart.itemId;

    if (!item) {
      throw new Error("Invalid cart item");
    }

    const itemTotal = item.price * cart.quantity;
    subtotal += itemTotal;

    return {
      // Stored as ObjectId (ref MenuItem) — casts were the old string format
      itemId: item._id,
      name: item.name,
      price: item.price,
      quantity: cart.quantity,
    };
  });

  const deliveryFee = subtotal < 250 ? 49 : 0;
  const platformFee = 7;
  const totalAmount = subtotal + deliveryFee + platformFee;

  // ─── Server-side distance & rider payout ──────────────────
  // Haversine (with a road detour factor) between the restaurant's
  // stored GeoJSON point and the saved address's stored point.
  const orderDistance = deliveryDistanceKm(
    restaurant.autoLocation.coordinates,
    address.location.coordinates,
  );
  const riderAmount = Math.ceil(orderDistance) * 17;

  // Online payments get 15 minutes to complete before the order expires.
  // COD has no payment window, so it never carries the expiry TTL.
  const isCod = paymentMethod === "cod";
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

  const [longitude, latitude] = address.location.coordinates;

  // ─── Transactional create: order + (COD) cart clear ───────
  // If any step fails, both roll back — no orphaned orders from a
  // failed cart delete, no carts wiped for an order that never got
  // created. Online-payment flows still clear the cart in the payment
  // consumer after the gateway confirms the money, so only the COD
  // path deletes inside the transaction.
  const session = await mongoose.startSession();
  try {
    let createdOrder!: mongoose.Document;
    await session.withTransaction(async () => {
      const [order] = await Order.create(
        [
          {
            userId: req.user!._id.toString(),
            addressId: addressId.toString(),
            paymentMethod,
            restaurantId: restaurantId.toString(),
            restaurantName: restaurant.name,
            // Frozen at creation so the live tracking map can draw the
            // pickup → dropoff route even if the restaurant moves later.
            restaurantLocation: {
              latitude: restaurant.autoLocation.coordinates[1],
              longitude: restaurant.autoLocation.coordinates[0],
            },
            riderId: null,
            items: orderItems,
            subtotal,
            deliveryFee,
            platformFee,
            totalAmount,
            distance: orderDistance,
            riderAmount,
            expiresAt,
            deliveryAddress: {
              formattedAddress: address.formatterAddress,
              mobile: address.mobile,
              latitude,
              longitude,
            },
            paymentStatus: isCod ? "paid" : "pending",
            status: "placed",
          },
        ],
        { session },
      );
      if (!order) {
        throw new Error("Order creation failed");
      }
      createdOrder = order;

      if (isCod) {
        await Cart.deleteMany({ userId: req.user!._id }, { session });
      }
    });

    const order = createdOrder;

    if (isCod) {
      // Transaction committed — now tell everyone. Notifications are
      // fire-and-forget and must stay OUTSIDE the transaction: the
      // commit is the single point where the order becomes real.
      notifyRealtime("order:new", `restaurant:${restaurantId}`, {
        orderId: order._id,
      });
      notifyRealtime("order:new", `user:${restaurant.ownerId}`, {
        orderId: order._id,
      });
      notifyRealtime("order:update", `user:${req.user._id}`, {
        orderId: order._id,
        status: "placed",
      });
    }

    return res.status(201).json({
      message: "Order created successfully",
      orderId: order._id.toString(),
      amount: totalAmount,
    });
  } finally {
    await session.endSession();
  }
});

export const fetchOrderForPayment = tryCatch(async (req, res) => {
  if (req.headers["x-internal-key"] !== process.env.INTERNAL_SERVICE_KEY) {
    throw new Error("Forbidden");
  }

  const order = await Order.findById(req.params.id);

  if (!order) {
    throw new Error("No order found");
  }

  if (order.paymentStatus !== "pending") {
    throw new Error("Order already paid");
  }

  return res.status(200).json({
    message: "Order fetched successfully",
    orderId: order._id,
    amount: order.totalAmount,
    currency: "INR",
  });
});

// ─── Restaurant Orders (keyset-paginated) ───────────────────
// Every response is bounded: default 50, hard cap 200, and deep pages
// use keyset (createdAt+id cursor) so page N costs the same as page 1.
// Deep pagination happens by following nextCursor, never by offset —
// an offset scan degrades linearly while a keyset seek stays flat.
const DEFAULT_ORDERS_LIMIT = 50;
const MAX_ORDERS_LIMIT = 200;

export const fetchRestaurantOrders = tryCatch(async (req: AuthRequest, res) => {
  const user = req.user;

  const { restaurantId } = req.params;

  if (!user) {
    throw new Error("Unauthorized");
  }

  if (!restaurantId) {
    throw new Error("Restaurant ID is required");
  }

  // Sellers may only read their own restaurant's orders
  const restaurant = await Restaurant.findById(restaurantId);

  if (!restaurant || restaurant.ownerId.toString() !== user._id.toString()) {
    throw new Error("Unauthorized");
  }

  const parsed = req.query.limit ? Number(req.query.limit) : DEFAULT_ORDERS_LIMIT;
  const limit = Math.min(
    Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_ORDERS_LIMIT,
    MAX_ORDERS_LIMIT,
  );

  // Keyset cursor: "createdAt|_id" of the last order of the previous page.
  // Ties on createdAt are broken by _id so pages never overlap or skip.
  const filter: Record<string, unknown> = { restaurantId, paymentStatus: "paid" };
  if (typeof req.query.cursor === "string" && req.query.cursor) {
    const [ts, id] = req.query.cursor.split("|");
    const cursorDate = ts ? new Date(ts) : null;
    if (
      cursorDate &&
      !Number.isNaN(cursorDate.getTime()) &&
      id &&
      mongoose.isValidObjectId(id)
    ) {
      filter.$or = [
        { createdAt: { $lt: cursorDate } },
        { createdAt: cursorDate, _id: { $lt: new mongoose.Types.ObjectId(id) } },
      ];
    }
  }

  // Fetch one extra row to detect a next page without a count query.
  const orders = await Order.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .select("-paymentIntent");

  const hasMore = orders.length > limit;
  const page = hasMore ? orders.slice(0, limit) : orders;

  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last?.createdAt
      ? `${new Date(last.createdAt).toISOString()}|${last._id.toString()}`
      : null;

  return res.status(200).json({
    success: true,
    count: page.length,
    orders: page,
    nextCursor,
  });
});

// ─── Seller Analytics (server-side rollups) ─────────────────
// One aggregation replaces shipping the entire order collection to the
// browser for client-side math: daily revenue buckets, window totals,
// previous-window comparison, completion counts, top items and weekday
// totals. Everything is computed in Mongo over the compound index
// { restaurantId, paymentStatus, createdAt } — the response is a few KB
// regardless of order volume.
const SELLER_STATUSES_EXCLUDED = ["cancelled"];

export const getRestaurantAnalytics = tryCatch(async (req: AuthRequest, res) => {
  const user = req.user;

  const { restaurantId } = req.params;

  if (!user) {
    throw new Error("Unauthorized");
  }

  if (!restaurantId) {
    throw new Error("Restaurant ID is required");
  }

  const restaurant = await Restaurant.findById(restaurantId);

  if (!restaurant || restaurant.ownerId.toString() !== user._id.toString()) {
    throw new Error("Unauthorized");
  }

  const windowDays = req.query.days === "30" ? 30 : 7;
  const now = new Date();
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  const windowStart = new Date(today);
  windowStart.setUTCDate(windowStart.getUTCDate() - (windowDays - 1));
  const prevStart = new Date(windowStart);
  prevStart.setUTCDate(prevStart.getUTCDate() - windowDays);

  // All analytics math runs on UTC day boundaries. The frontend buckets by
  // its local day; a restaurant in a half-hour-offset timezone can shift a
  // midnight order ±1 bucket. Acceptable for dashboards; revisit with a
  // per-restaurant timezone if merchants ever complain about day edges.
  const [result] = await Order.aggregate<{
    window: { revenue: number; orders: number }[];
    previous: { revenue: number; orders: number }[];
    delivered: { n: number }[];
    cancelled: { n: number }[];
    days: { _id: string; revenue: number; orders: number }[];
    weekdays: { _id: number; revenue: number }[];
    topItems: { _id: string; revenue: number; qty: number }[];
  }>([
    {
      $match: {
        restaurantId: restaurantId,
        paymentStatus: "paid",
        createdAt: { $gte: prevStart },
      },
    },
    {
      $facet: {
        // Current window vs preceding same-length window
        window: [
          { $match: { createdAt: { $gte: windowStart } } },
          {
            $group: {
              _id: null,
              revenue: { $sum: "$totalAmount" },
              orders: { $sum: 1 },
            },
          },
        ],
        previous: [
          { $match: { createdAt: { $lt: windowStart } } },
          {
            $group: {
              _id: null,
              revenue: { $sum: "$totalAmount" },
              orders: { $sum: 1 },
            },
          },
        ],
        delivered: [
          { $match: { status: "delivered" } },
          { $count: "n" },
        ],
        cancelled: [
          { $match: { status: "cancelled" } },
          { $count: "n" },
        ],
        // Daily buckets for the chart (current window only)
        days: [
          { $match: { createdAt: { $gte: windowStart } } },
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
              revenue: { $sum: "$totalAmount" },
              orders: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ],
        // Revenue by weekday across BOTH windows (matches the old
        // client-side calc which used the whole fetched history)
        weekdays: [
          {
            $group: {
              _id: { $dayOfWeek: "$createdAt" },
              revenue: { $sum: "$totalAmount" },
            },
          },
          { $sort: { _id: 1 } },
        ],
        // Best sellers — unwinding items is fine here because the $match
        // above already bounded the docset to ~2 windows of one restaurant
        topItems: [
          { $unwind: "$items" },
          {
            $group: {
              _id: "$items.name",
              revenue: { $sum: { $multiply: ["$items.price", "$items.quantity"] } },
              qty: { $sum: "$items.quantity" },
            },
          },
          { $sort: { revenue: -1 } },
          { $limit: 5 },
        ],
      },
    },
  ]);

  // $facet always returns every facet key as an array (empty when the
  // pipeline matched nothing), so no null-guarding is needed — but a
  // missing aggregation result still means "no data".
  const safe = result ?? {
    window: [],
    previous: [],
    delivered: [],
    cancelled: [],
    days: [],
    weekdays: [],
    topItems: [],
  };

  const prevRevenue = safe.previous[0]?.revenue ?? 0;
  const windowRevenue = safe.window[0]?.revenue ?? 0;
  const windowOrders = safe.window[0]?.orders ?? 0;
  const deliveredCount = safe.delivered[0]?.n ?? 0;
  const cancelledCount = safe.cancelled[0]?.n ?? 0;

  const dayMap = new Map(safe.days.map((d) => [d._id, d]));
  const buckets = Array.from({ length: windowDays }, (_, i) => {
    const d = new Date(windowStart);
    d.setUTCDate(d.getUTCDate() + i);
    const key = d.toISOString().slice(0, 10);
    const hit = dayMap.get(key);
    return {
      date: key,
      revenue: hit?.revenue ?? 0,
      orders: hit?.orders ?? 0,
    };
  });

  // Mongo $dayOfWeek: 1=Sunday … 7=Saturday → shift to JS getDay()
  // indexing (0=Sunday … 6=Saturday)
  const weekdayTotals = new Array<number>(7).fill(0);
  for (const wd of safe.weekdays) {
    weekdayTotals[wd._id - 1] = wd.revenue;
  }

  const change =
    prevRevenue > 0
      ? Math.round(((windowRevenue - prevRevenue) / prevRevenue) * 100)
      : windowRevenue > 0
        ? 100
        : 0;

  return res.status(200).json({
    success: true,
    analytics: {
      window: windowDays,
      windowRevenue,
      windowOrders,
      avgOrder: windowOrders ? Math.round(windowRevenue / windowOrders) : 0,
      change,
      prevRevenue,
      delivered: deliveredCount,
      cancelled: cancelledCount,
      completionRate:
        deliveredCount + cancelledCount > 0
          ? Math.round((deliveredCount / (deliveredCount + cancelledCount)) * 100)
          : null,
      buckets,
      weekdayTotals,
      topItems: safe.topItems.map((t) => ({
        name: t._id,
        revenue: t.revenue,
        qty: t.qty,
      })),
    },
  });
});

const ACCEPTED_STATUSES = ["preparing", "ready_for_rider", "accepted"];

export const updateOrderStatus = tryCatch(async (req: AuthRequest, res) => {
  const user = req.user;

  const { orderId } = req.params;
  const { status } = req.body;

  if (!user) {
    throw new Error("Unauthorized");
  }

  if (!ACCEPTED_STATUSES.includes(status)) {
    throw new Error("Invalid status");
  }

  if (!orderId) {
    throw new Error("Order ID is required");
  }

  const order = await Order.findById(orderId);

  if (!order) {
    throw new Error("No order found");
  }

  if (order.paymentStatus !== "paid") {
    throw new Error("Order not paid");
  }

  const restaurant = await Restaurant.findById(order.restaurantId);

  if (!restaurant) {
    throw new Error("No restaurant found");
  }

  if (restaurant.ownerId.toString() !== user._id.toString()) {
    throw new Error("Unauthorized");
  }

  order.status = status;
  await order.save();

  notifyRealtime("order:update", `user:${order.userId}`, {
    orderId: order._id,
    status: order.status,
  });
  notifyRealtime("order:update", `restaurant:${order.restaurantId}`, {
    orderId: order._id,
    status: order.status,
  });
  // Seller sockets join user:{id} rooms, not restaurant:{id} — emit to the
  // owner too so their own board updates without a refresh.
  notifyRealtime("order:update", `user:${restaurant.ownerId}`, {
    orderId: order._id,
    status: order.status,
  });

  if(status === "ready_for_rider") {
    console.log("Order is ready for rider",order._id)

    await publishEvent("order:ready_for_rider", {
      orderId: order._id,
      restaurantId: restaurant._id,
      // Plain GeoJSON object — Mongoose subdocs carry $-prefixed keys that
      // break $near on the rider service's geo query.
      location: {
        type: "Point",
        coordinates: restaurant.autoLocation.coordinates,
      },
    });
    
    console.log("Event published")
  }

  // Seller cancelled an order that already has a rider assigned → free them
  if (status === "cancelled" && order.riderId) {
    releaseRider(order.riderId);
  }

  return res.status(200).json({
    message: "Order updated successfully",
    order,
  });
});

// ─── Cancel Order (customer or seller) ──────────────────────
// Allowed while the order has no rider on the road yet: before assignment,
// or while assigned but not picked up. Releases the rider automatically.
export const cancelOrder = tryCatch(async (req: AuthRequest, res) => {
  const user = req.user;

  if (!user) {
    throw new Error("Unauthorized");
  }

  const { orderId } = req.params;

  if (!orderId) {
    throw new Error("Order ID is required");
  }

  const order = await Order.findById(orderId);

  if (!order) {
    throw new Error("No order found");
  }

  const isOwner = order.userId.toString() === user._id.toString();
  const isSeller = order.restaurantName && user.role === "seller";

  // Sellers may cancel through their restaurant; customers only their own order
  if (isSeller) {
    const restaurant = await Restaurant.findById(order.restaurantId);
    if (!restaurant || restaurant.ownerId.toString() !== user._id.toString()) {
      throw new Error("Unauthorized");
    }
  } else if (!isOwner) {
    throw new Error("Unauthorized");
  }

  if (order.status === "delivered") {
    throw new Error("Delivered orders cannot be cancelled");
  }

  if (order.status === "picked_up") {
    throw new Error("Order is already picked up — cancellation not possible");
  }

  const hadRiderAssigned = order.status === "rider_assigned";

  order.status = "cancelled";
  await order.save();

  // Free the rider if one was on the way
  if (hadRiderAssigned && order.riderId) {
    releaseRider(order.riderId);
  }

  // Customer + seller dashboards refresh instantly
  notifyRealtime("order:update", `user:${order.userId}`, {
    orderId: order._id,
    status: "cancelled",
  });
  notifyRealtime("order:update", `restaurant:${order.restaurantId}`, {
    orderId: order._id,
    status: "cancelled",
  });
  const cancelRestaurant = await Restaurant.findById(order.restaurantId);
  if (cancelRestaurant) {
    notifyRealtime("order:update", `user:${cancelRestaurant.ownerId}`, {
      orderId: order._id,
      status: "cancelled",
    });
  }

  return res.status(200).json({
    success: true,
    message: "Order cancelled successfully",
    order,
  });
});

export const getMyOrders = tryCatch(async (req: AuthRequest, res) => {
  const user = req.user;

  if (!user) {
    throw new Error("Unauthorized");
  }

  const orders = await Order.find({ 
    userId: user._id,
    paymentStatus: "paid"
   }).sort({ createdAt: -1 });

  return res.status(200).json({
    success: true,
    count: orders.length,
    orders,
  });
});

// ─── Order Payment Status (read-only, poll-friendly) ────────
// The frontend polls this after the payment gateway redirect while the
// webhook (source of truth) flips the order to paid in the background.
// Strictly read-only — the client can never fulfill a payment here.
export const getOrderPaymentStatus = tryCatch(async (req: AuthRequest, res) => {
  const user = req.user;

  if (!user) {
    throw new Error("Unauthorized");
  }

  const { orderId } = req.params;

  if (!orderId) {
    return res.status(400).json({ message: "Order ID is required" });
  }

  const order = await Order.findById(orderId).select(
    "userId status paymentStatus totalAmount",
  );

  if (!order) {
    return res.status(404).json({ message: "No order found" });
  }

  if (order.userId.toString() !== user._id.toString()) {
    throw new Error("Unauthorized");
  }

  return res.status(200).json({
    success: true,
    orderId: order._id,
    paymentStatus: order.paymentStatus,
    status: order.status,
    totalAmount: order.totalAmount,
  });
});

export const fetchSingleOrder = tryCatch(async (req: AuthRequest, res) => {
  const user = req.user;

  const { orderId } = req.params;

  if (!user) {
    throw new Error("Unauthorized");
  }

  if (!orderId) {
    throw new Error("Order ID is required");
  }

  const order = await Order.findById(orderId);

  if (!order) {
    throw new Error("No order found");
  }

  if (order.userId.toString() !== user._id.toString()) {
    throw new Error("Unauthorized");
  }

  // Enrich items with menu images (the embedded snapshot stores only
  // name/price/quantity) — one batched lookup, no per-item queries.
  const itemIds = order.items.map((i) => i.itemId);
  const menuItems = await MenuItem.find({ _id: { $in: itemIds } }).select(
    "image",
  );
  const imageById = new Map(menuItems.map((m) => [m._id.toString(), m.image]));

  const orderObj = order.toObject() as any;
  orderObj.items = orderObj.items.map((item: any) => ({
    ...item,
    image: imageById.get(item.itemId) ?? null,
  }));

  return res.status(200).json({
    success: true,
    order: orderObj,
  });
});


// ─── Core: assign a rider to an order (atomic claim) ────────
// Shared by the internal HTTP endpoint and the rider.order_accepted
// consumer. The conditional update on riderId: null makes double-assign
// impossible; a false result means the order is gone, taken, or expired.
export const assignRiderToOrder = async (payload: {
  orderId: string;
  riderId: string;
  riderUserId?: string;
  riderName?: string;
  riderPhone?: number | string;
  riderPicture?: string | null;
}): Promise<{ success: boolean; order?: any }> => {
  const orderUpdate = await Order.findOneAndUpdate(
    { _id: payload.orderId, riderId: null },
    {
      riderId: payload.riderId,
      riderName: payload.riderName,
      riderPhone: payload.riderPhone,
      riderPicture: payload.riderPicture || null,
      status: "rider_assigned",
    },
    { new: true },
  );

  if (!orderUpdate) {
    return { success: false };
  }

  // Restaurant board (restaurantId room) — restaurantId is an ObjectId,
  // the restaurant room expects the same id the socket joined with.
  publishRealtimeEvent(
    "order:rider_assigned",
    `restaurant:${orderUpdate.restaurantId}`,
    { order: orderUpdate },
  );
  // Seller's own socket (user room) + customer's "rider is on the way"
  publishRealtimeEvent("order:rider_assigned", `user:${orderUpdate.userId}`, {
    order: orderUpdate,
  });

  const assignedRestaurant = await Restaurant.findById(orderUpdate.restaurantId);
  if (assignedRestaurant) {
    publishRealtimeEvent(
      "order:rider_assigned",
      `user:${assignedRestaurant.ownerId}`,
      { order: orderUpdate },
    );
  }
  // The rider's own dashboard so Active Delivery flips without waiting
  // for the next poll
  if (payload.riderUserId) {
    publishRealtimeEvent("order:rider_assigned", `user:${payload.riderUserId}`, {
      order: orderUpdate,
    });
  }

  return { success: true, order: orderUpdate };
};

// Internal HTTP entry kept for the contract; the primary path is now the
// rider.order_accepted consumer.
export const assignOrderToRider = tryCatch(async (req: AuthRequest, res) => {
  if (req.headers["x-internal-key"] !== process.env.INTERNAL_SERVICE_KEY) {
    throw new Error("Forbidden");
  }

  const { orderId, riderId, riderUserId, riderName, riderPhone, riderPicture } =
    req.body;

  if (!orderId || !riderId) {
    throw new Error("Order ID and rider ID are required");
  }

  const result = await assignRiderToOrder({
    orderId,
    riderId,
    riderUserId,
    riderName,
    riderPhone,
    riderPicture,
  });

  if (!result.success) {
    return res.status(409).json({
      success: false,
      message: "Order not found or already assigned",
    });
  }

  return res.status(200).json({
    success: true,
    order: result.order,
  });
});

// ─── Ready Orders Near a Rider (internal) ───────────────────
// Used by the rider service's "available orders" list. Returns paid
// orders waiting for a rider at restaurants within 10km of the rider.
export const getReadyOrdersNearRider = tryCatch(async (req, res) => {
  if (req.headers["x-internal-key"] !== process.env.INTERNAL_SERVICE_KEY) {
    throw new Error("Forbidden");
  }

  const latitude = Number(req.query.latitude);
  const longitude = Number(req.query.longitude);

  if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
    throw new Error("latitude and longitude are required");
  }

  const nearbyRestaurants = await Restaurant.find({
    autoLocation: {
      $near: {
        $geometry: { type: "Point", coordinates: [longitude, latitude] },
        $maxDistance: 10000, // 10km in meters — same radius as the matcher
      },
    },
  });

  const orders = await Order.find({
    status: "ready_for_rider",
    paymentStatus: "paid",
    restaurantId: {
      $in: nearbyRestaurants.map((r) => (r._id as mongoose.Types.ObjectId).toString()),
    },
  }).sort({ createdAt: 1 });

  return res.status(200).json({
    success: true,
    count: orders.length,
    orders,
  });
});

// ─── Rider Delivery History (internal) ──────────────────────
// Used by the rider service to power the rider's Earnings + History pages.
// Returns delivered orders for a rider, newest first.
export const getRiderDeliveryHistory = tryCatch(async (req, res) => {
  if (req.headers["x-internal-key"] !== process.env.INTERNAL_SERVICE_KEY) {
    throw new Error("Forbidden");
  }

  const riderId = req.query.riderId as string;

  if (!riderId) {
    throw new Error("Rider ID is required");
  }

  const orders = await Order.find({
    riderId,
    status: "delivered",
    paymentStatus: "paid",
  }).sort({ createdAt: -1 });

  return res.status(200).json({
    success: true,
    count: orders.length,
    orders,
  });
});

export const getCurrentOrdersForRider = tryCatch(async (req: AuthRequest, res) => {
  if (req.headers["x-internal-key"] !== process.env.INTERNAL_SERVICE_KEY) {
    throw new Error("Forbidden");
  }

  const riderId = req.query.riderId as string;

  if(!riderId) {
    throw new Error("Rider ID is required");
  }

  const order = await Order.findOne({
    riderId,
    status: { $ne: "delivered" }
  }).populate("restaurantId");

  return res.status(200).json({
    success: true,
    order,
  });
});

export const updateOrderStatusRider = tryCatch(async (req: AuthRequest, res) => {
  if (req.headers["x-internal-key"] !== process.env.INTERNAL_SERVICE_KEY) {
    return res.status(403).json({ message: "Forbidden" });
  }

  const { orderId } = req.body;

  if (!orderId) {
    return res.status(400).json({ message: "Order ID is required" });
  }

  const order = await Order.findById(orderId);

  if (!order) {
    return res.status(404).json({ message: "No order found" });
  }

  if (order.status === "rider_assigned") {
    order.status = "picked_up";
    await order.save();

    // Customer sees "picked up"; seller sees the board move to In Delivery
    notifyRealtime("order:update", `user:${order.userId}`, {
      orderId: order._id,
      status: order.status,
    });
    notifyRealtime("order:update", `restaurant:${order.restaurantId}`, {
      orderId: order._id,
      status: order.status,
    });
    const pickedUpRestaurant = await Restaurant.findById(order.restaurantId);
    if (pickedUpRestaurant) {
      notifyRealtime("order:update", `user:${pickedUpRestaurant.ownerId}`, {
        orderId: order._id,
        status: order.status,
      });
    }

    return res.json({
      success: true,
      message: "Order status updated successfully",
      order,
    });
  }

  if (order.status === "picked_up") {
    order.status = "delivered";
    await order.save();

    // Customer + seller both learn the delivery is complete
    notifyRealtime("order:delivered", `user:${order.userId}`, order);
    notifyRealtime("order:update", `user:${order.userId}`, {
      orderId: order._id,
      status: order.status,
    });
    notifyRealtime("order:update", `restaurant:${order.restaurantId}`, {
      orderId: order._id,
      status: order.status,
    });
    const deliveredRestaurant = await Restaurant.findById(order.restaurantId);
    if (deliveredRestaurant) {
      notifyRealtime("order:update", `user:${deliveredRestaurant.ownerId}`, {
        orderId: order._id,
        status: order.status,
      });
    }

    return res.json({
      success: true,
      message: "Order status updated successfully",
      order,
    });
  }

  return res.json({
    success: true,
    message: "Order status unchanged",
    order,
  });
});

// ─── Internal: Claim an Order for Payment Initiation ────────
// utils calls this BEFORE creating a provider payment intent. Atomic and
// idempotent: paid/cancelled orders are rejected, and any previously
// attached provider order id is handed back so double-clicks and retry
// storms re-issue the SAME intent instead of minting duplicates. The
// amount also comes from this claim, closing the trust gap where the
// internal amount fetch could race an order update.
export const claimOrderForPayment = tryCatch(async (req, res) => {
  if (req.headers["x-internal-key"] !== process.env.INTERNAL_SERVICE_KEY) {
    throw new Error("Forbidden");
  }

  const { orderId } = req.params;
  const { provider } = req.body ?? {};

  if (!orderId) {
    return res.status(400).json({ message: "Order ID is required" });
  }

  if (provider !== "razorpay" && provider !== "stripe") {
    return res.status(400).json({ message: "Valid provider is required" });
  }

  const order = await Order.findOneAndUpdate(
    {
      _id: orderId,
      paymentStatus: { $ne: "paid" },
      status: { $ne: "cancelled" },
    },
    {
      $set: {
        "paymentIntent.provider": provider,
        "paymentIntent.initiatedAt": new Date(),
      },
    },
    { new: true },
  ).select("totalAmount paymentIntent");

  // TTL'd unpaid orders are already gone → same 409 as paid/cancelled
  if (!order) {
    return res.status(409).json({
      message: "Order not claimable (paid, cancelled, or expired)",
    });
  }

  const attached =
    order.paymentIntent?.provider === provider
      ? order.paymentIntent?.providerOrderId ?? null
      : null;

  return res.status(200).json({
    success: true,
    orderId: order._id,
    amount: order.totalAmount,
    currency: "INR",
    attachedProviderOrderId: attached,
  });
});

// ─── Internal: Attach the Provider Order Id ─────────────────
// utils calls back right after creating the provider intent so every
// future claim re-issues the same one.
export const attachProviderOrder = tryCatch(async (req, res) => {
  if (req.headers["x-internal-key"] !== process.env.INTERNAL_SERVICE_KEY) {
    throw new Error("Forbidden");
  }

  const { orderId } = req.params;
  const { provider, providerOrderId } = req.body ?? {};

  if (!orderId || !providerOrderId) {
    return res
      .status(400)
      .json({ message: "Order ID and providerOrderId are required" });
  }

  if (provider !== "razorpay" && provider !== "stripe") {
    return res.status(400).json({ message: "Valid provider is required" });
  }

  const order = await Order.findOneAndUpdate(
    { _id: orderId, paymentStatus: { $ne: "paid" } },
    {
      $set: {
        "paymentIntent.provider": provider,
        "paymentIntent.providerOrderId": providerOrderId,
        "paymentIntent.initiatedAt": new Date(),
      },
    },
    { new: true },
  ).select("_id paymentIntent");

  if (!order) {
    return res
      .status(409)
      .json({ message: "Order not attachable (paid or expired)" });
  }

  return res.status(200).json({ success: true });
});

// ─── Internal: Reconciliation Candidates ────────────────────
// Pending orders whose payment intent was initiated longer than the window
// ago and never became paid. utils audits these against the provider:
// captured money is republished through the SAME idempotent queue path as
// webhooks; created-but-never-paid intents are flagged as orphans.
export const getReconciliationCandidates = tryCatch(async (req, res) => {
  if (req.headers["x-internal-key"] !== process.env.INTERNAL_SERVICE_KEY) {
    throw new Error("Forbidden");
  }

  const olderThanMinutes = Number(req.query.olderThanMinutes) || 20;
  const since = new Date(Date.now() - olderThanMinutes * 60 * 1000);

  const orders = await Order.find({
    paymentStatus: "pending",
    "paymentIntent.providerOrderId": { $exists: true, $ne: null },
    "paymentIntent.initiatedAt": { $lte: since },
  })
    .limit(100)
    .select("_id paymentIntent paymentStatus totalAmount");

  return res.status(200).json({
    success: true,
    count: orders.length,
    orders,
  });
});
