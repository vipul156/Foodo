import { AuthRequest, tryCatch } from "@foodo/backend-common";
import {
  getOrderById,
  listOrdersByUser,
  listOrdersByRestaurant,
  isValidOrderId,
  createOrder as createOrderRecord,
  setOrderStatus,
  cancelOrder,
  claimOrderForPayment,
  getRestaurantById,
} from "@foodo/backend-common/dynamo";
import { deliveryDistanceKm } from "@foodo/backend-common/aws";
import {
  getAddress,
  getCartRows,
  fetchMenuItemsForCart,
} from "../dynamo/cart.js";
import {
  publishEvent,
  publishOrderEvent,
  publishRealtimeEvent,
} from "../config/events.js";

function releaseRider(riderId: unknown, orderId?: unknown) {
  if (!riderId) return;
  publishOrderEvent("order.cancelled", {
    riderId,
    orderId: orderId ?? null,
  }).catch((err) =>
    console.error(
      "Rider release publish failed:",
      err instanceof Error ? err.message : err,
    ),
  );
}

export const createOrder = tryCatch(async (req: AuthRequest, res) => {
  if (!req.user) {
    throw new Error("User not found");
  }

  // `distance` is never accepted from the body — it sets the rider's
  // payout. Computed server-side from the two stored coordinate pairs.
  const { addressId, paymentMethod } = req.body;

  if (!paymentMethod) {
    throw new Error("Payment method is required");
  }
  if (!addressId) {
    throw new Error("Address is required");
  }

  const address = await getAddress(String(req.user.id), String(addressId));
  if (!address) {
    throw new Error("Address not found");
  }

  const cartRows = await getCartRows(String(req.user.id));
  if (cartRows.length === 0) {
    throw new Error("Cart is empty");
  }

  const restaurantId = cartRows[0]!.restaurantId;

  const restaurant = await getRestaurantById(restaurantId);
  if (!restaurant) {
    throw new Error("No restaurant with this id");
  }
  if (!restaurant.isOpen) {
    throw new Error("Restaurant is closed");
  }

  // Enrich cart rows with menu items (replaces populate("itemId")).
  const menuById = await fetchMenuItemsForCart(
    cartRows.map((r) => r.itemId),
  );

  let subtotal = 0;
  const orderItems: {
    itemId: string;
    name: string;
    price: number;
    quantity: number;
  }[] = [];

  for (const row of cartRows) {
    const item = menuById.get(row.itemId);
    if (!item) {
      throw new Error("Invalid cart item");
    }
    const itemTotal = item.price * row.quantity;
    subtotal += itemTotal;
    orderItems.push({
      itemId: item.id,
      name: item.name,
      price: item.price,
      quantity: row.quantity,
    });
  }

  const deliveryFee = subtotal < 250 ? 49 : 0;
  const platformFee = 7;
  const totalAmount = subtotal + deliveryFee + platformFee;

  const orderDistance = deliveryDistanceKm(
    restaurant.autoLocation.coordinates,
    address.location.coordinates,
  );
  const riderAmount = Math.ceil(orderDistance) * 17;

  const isCod = paymentMethod === "cod";
  const expiresAt = isCod
    ? null
    : new Date(Date.now() + 15 * 60 * 1000);

  const [longitude, latitude] = address.location.coordinates;

  // Transactional create: order + (COD) cart clear commit together via
  // TransactWriteItems — notifications stay outside the transaction.
  const order = await createOrderRecord(
    {
      userId: String(req.user.id),
      restaurantId,
      restaurantName: restaurant.name,
      restaurantLocation: {
        latitude: restaurant.autoLocation.coordinates[1]!,
        longitude: restaurant.autoLocation.coordinates[0]!,
      },
      items: orderItems,
      subtotal,
      deliveryFee,
      platformFee,
      totalAmount,
      distance: orderDistance,
      riderAmount,
      addressId: String(addressId),
      deliveryAddress: {
        formattedAddress: address.formatterAddress,
        mobile: address.mobile,
        latitude,
        longitude,
      },
      paymentMethod,
      paymentStatus: isCod ? "paid" : "pending",
      expiresAt,
    },
    isCod ? { userId: String(req.user.id) } : undefined,
  );

  if (isCod) {
    await publishRealtimeEvent("order:new", `restaurant:${restaurantId}`, {
      orderId: order.id,
    });
    await publishRealtimeEvent("order:new", `user:${restaurant.ownerId}`, {
      orderId: order.id,
    });
    await publishRealtimeEvent("order:update", `user:${req.user.id}`, {
      orderId: order.id,
      status: "placed",
    });
  }

  return res.status(201).json({
    message: "Order created successfully",
    orderId: order.id,
    amount: totalAmount,
  });
});

// ─── Restaurant Orders (keyset-paginated) ────────────────────
// Same wire contract: nextCursor = "createdAt|id", bounded page sizes.

const DEFAULT_ORDERS_LIMIT = 50;
const MAX_ORDERS_LIMIT = 200;

export const fetchRestaurantOrders = tryCatch(async (req: AuthRequest, res) => {
  const user = req.user;
  const restaurantId = req.params.restaurantId as string;

  if (!user) {
    throw new Error("Unauthorized");
  }
  if (!restaurantId) {
    throw new Error("Restaurant ID is required");
  }

  const restaurant = await getRestaurantById(restaurantId);
  if (!restaurant || restaurant.ownerId !== String(user.id)) {
    throw new Error("Unauthorized");
  }

  const parsed = req.query.limit ? Number(req.query.limit) : DEFAULT_ORDERS_LIMIT;
  const limit = Math.min(
    Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_ORDERS_LIMIT,
    MAX_ORDERS_LIMIT,
  );

  const { orders, nextCursor } = await listOrdersByRestaurant(
    restaurantId,
    {
      limit,
      cursor:
        typeof req.query.cursor === "string" && req.query.cursor
          ? req.query.cursor
          : null,
    },
  );

  return res.status(200).json({
    success: true,
    count: orders.length,
    orders,
    nextCursor,
  });
});

// ─── Seller Analytics (computed in Lambda, not the DB) ───────
// DynamoDB has no $facet. The bounded window query (paid orders of one
// restaurant since the previous window start) replaces the aggregation:
// fetch once over the restaurant-orders GSI, roll up in memory. Same
// response shape; volume per restaurant per 60 days is dashboard-sized.

const SELLER_STATUSES_EXCLUDED = ["cancelled"];

export const getRestaurantAnalytics = tryCatch(async (req: AuthRequest, res) => {
  const user = req.user;
  const restaurantId = req.params.restaurantId as string;

  if (!user) {
    throw new Error("Unauthorized");
  }
  if (!restaurantId) {
    throw new Error("Restaurant ID is required");
  }

  const restaurant = await getRestaurantById(restaurantId);
  if (!restaurant || restaurant.ownerId !== String(user.id)) {
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

  // One bounded GSI query (newest→oldest until prevStart), rollups here.
  const { orders } = await listOrdersByRestaurant(restaurantId, { limit: 500 });
  const paid = orders.filter(
    (o) =>
      o.paymentStatus === "paid" &&
      !SELLER_STATUSES_EXCLUDED.includes(o.status) &&
      new Date(o.createdAt) >= prevStart,
  );

  let windowRevenue = 0, windowOrders = 0, prevRevenue = 0;
  let delivered = 0, cancelled = 0;
  const dayMap = new Map<string, { revenue: number; orders: number }>();
  const weekdayTotals = new Array<number>(7).fill(0);
  const itemMap = new Map<string, { revenue: number; qty: number }>();

  for (const o of paid) {
    const created = new Date(o.createdAt);
    weekdayTotals[created.getUTCDay()]! += o.totalAmount;

    if (created >= windowStart) {
      windowRevenue += o.totalAmount;
      windowOrders += 1;

      const key = o.createdAt.slice(0, 10);
      const bucket = dayMap.get(key) ?? { revenue: 0, orders: 0 };
      bucket.revenue += o.totalAmount;
      bucket.orders += 1;
      dayMap.set(key, bucket);
    } else {
      prevRevenue += o.totalAmount;
    }

    if (o.status === "delivered") delivered += 1;
    if (o.status === "cancelled") cancelled += 1;

    for (const item of o.items) {
      const agg = itemMap.get(item.name) ?? { revenue: 0, qty: 0 };
      agg.revenue += item.price * item.quantity;
      agg.qty += item.quantity;
      itemMap.set(item.name, agg);
    }
  }

  const buckets = Array.from({ length: windowDays }, (_, i) => {
    const d = new Date(windowStart);
    d.setUTCDate(d.getUTCDate() + i);
    const key = d.toISOString().slice(0, 10);
    const hit = dayMap.get(key);
    return { date: key, revenue: hit?.revenue ?? 0, orders: hit?.orders ?? 0 };
  });

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
      delivered,
      cancelled,
      completionRate:
        delivered + cancelled > 0
          ? Math.round((delivered / (delivered + cancelled)) * 100)
          : null,
      buckets,
      weekdayTotals,
      topItems: [...itemMap.entries()]
        .sort((a, b) => b[1].revenue - a[1].revenue)
        .slice(0, 5)
        .map(([name, agg]) => ({ name, revenue: agg.revenue, qty: agg.qty })),
    },
  });
});

const ACCEPTED_STATUSES = ["preparing", "ready_for_rider", "accepted"];

export const updateOrderStatus = tryCatch(async (req: AuthRequest, res) => {
  const user = req.user;
  const orderId = req.params.orderId as string;
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

  const order = await getOrderById(orderId);
  if (!order) {
    throw new Error("No order found");
  }
  if (order.paymentStatus !== "paid") {
    throw new Error("Order not paid");
  }

  const restaurant = await getRestaurantById(order.restaurantId);
  if (!restaurant) {
    throw new Error("No restaurant found");
  }
  if (restaurant.ownerId !== String(user.id)) {
    throw new Error("Unauthorized");
  }

  const updated = await setOrderStatus(orderId, status);
  if (!updated) {
    throw new Error("Order not paid");
  }

  await publishRealtimeEvent("order:update", `user:${updated.userId}`, {
    orderId: updated.id,
    status: updated.status,
  });
  await publishRealtimeEvent(
    "order:update",
    `restaurant:${updated.restaurantId}`,
    { orderId: updated.id, status: updated.status },
  );
  await publishRealtimeEvent("order:update", `user:${restaurant.ownerId}`, {
    orderId: updated.id,
    status: updated.status,
  });

  if (status === "ready_for_rider") {
    await publishEvent("order:ready_for_rider", {
      orderId: updated.id,
      restaurantId: updated.restaurantId,
      location: {
        type: "Point",
        coordinates: restaurant.autoLocation.coordinates,
      },
    });
  }

  if (status === "cancelled" && updated.riderId) {
    releaseRider(updated.riderId, updated.id);
  }

  return res.status(200).json({
    message: "Order updated successfully",
    order: updated,
  });
});

export const cancelOrderController = tryCatch(async (req: AuthRequest, res) => {
  const user = req.user;
  if (!user) {
    throw new Error("Unauthorized");
  }

  const orderId = req.params.orderId as string;
  if (!orderId) {
    throw new Error("Order ID is required");
  }

  const order = await getOrderById(orderId);
  if (!order) {
    throw new Error("No order found");
  }

  const isOwner = order.userId === String(user.id);
  const isSellerUser = order.restaurantName && user.role === "seller";

  if (isSellerUser) {
    const restaurant = await getRestaurantById(order.restaurantId);
    if (!restaurant || restaurant.ownerId !== String(user.id)) {
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

  const cancelled = await cancelOrder(orderId);
  if (!cancelled) {
    // The conditional update matched nothing — the pre-checks above
    // already filtered delivered/picked_up, so this is a lost race
    // (someone else delivered or cancelled first).
    throw new Error("Order can no longer be cancelled");
  }

  if (order.status === "rider_assigned" && order.riderId) {
    releaseRider(order.riderId, order.id);
  }

  await publishRealtimeEvent("order:update", `user:${order.userId}`, {
    orderId: order.id,
    status: "cancelled",
  });
  await publishRealtimeEvent(
    "order:update",
    `restaurant:${order.restaurantId}`,
    { orderId: order.id, status: "cancelled" },
  );
  const cancelRestaurant = await getRestaurantById(order.restaurantId);
  if (cancelRestaurant) {
    await publishRealtimeEvent("order:update", `user:${cancelRestaurant.ownerId}`, {
      orderId: order.id,
      status: "cancelled",
    });
  }

  return res.status(200).json({
    success: true,
    message: "Order cancelled successfully",
    order: cancelled,
  });
});

export const getMyOrders = tryCatch(async (req: AuthRequest, res) => {
  const user = req.user;
  if (!user) {
    throw new Error("Unauthorized");
  }

  const orders = await listOrdersByUser(String(user.id));

  return res.status(200).json({
    success: true,
    count: orders.length,
    orders,
  });
});

export const getOrderPaymentStatus = tryCatch(async (req: AuthRequest, res) => {
  const user = req.user;
  if (!user) {
    throw new Error("Unauthorized");
  }

  const orderId = req.params.orderId as string;
  if (!orderId) {
    return res.status(400).json({ message: "Order ID is required" });
  }

  const order = await getOrderById(orderId);
  if (!order) {
    return res.status(404).json({ message: "No order found" });
  }

  if (order.userId !== String(user.id)) {
    throw new Error("Unauthorized");
  }

  return res.status(200).json({
    success: true,
    orderId: order.id,
    paymentStatus: order.paymentStatus,
    status: order.status,
    totalAmount: order.totalAmount,
  });
});

export const fetchSingleOrder = tryCatch(async (req: AuthRequest, res) => {
  const user = req.user;
  const orderId = req.params.orderId as string;

  if (!user) {
    throw new Error("Unauthorized");
  }
  if (!orderId) {
    throw new Error("Order ID is required");
  }

  const order = await getOrderById(orderId);
  if (!order) {
    throw new Error("No order found");
  }
  if (order.userId !== String(user.id)) {
    throw new Error("Unauthorized");
  }

  // Enrich items with menu images — batched lookups, no per-item queries.
  const menuById = await fetchMenuItemsForCart(
    order.items.map((i) => i.itemId),
  );

  const orderObj: any = { ...order, pk: undefined, sk: undefined };
  orderObj.items = order.items.map((item) => ({
    ...item,
    image: menuById.get(item.itemId)?.image ?? null,
  }));

  return res.status(200).json({
    success: true,
    order: orderObj,
  });
});

// ─── Internal: Claim an Order for Payment Initiation ─────────
// utils calls this before creating a provider intent. Atomic +
// idempotent via the conditional update in the repository.

export const claimOrderForPaymentController = tryCatch(async (req, res) => {
  if (req.headers["x-internal-key"] !== process.env.INTERNAL_SERVICE_KEY) {
    throw new Error("Forbidden");
  }

  const orderId = (req.params.orderId || req.params.id) as string;
  const { provider } = req.body ?? {};

  if (!orderId) {
    return res.status(400).json({ message: "Order ID is required" });
  }
  if (provider !== "razorpay" && provider !== "stripe") {
    return res.status(400).json({ message: "Valid provider is required" });
  }
  if (!isValidOrderId(orderId)) {
    return res.status(409).json({
      message: "Order not claimable (paid, cancelled, or expired)",
    });
  }

  const claim = await claimOrderForPayment(orderId, provider);

  // TTL'd unpaid orders are already gone → same 409 as paid/cancelled
  if (!claim) {
    return res.status(409).json({
      message: "Order not claimable (paid, cancelled, or expired)",
    });
  }

  return res.status(200).json({
    success: true,
    orderId: claim.order.id,
    amount: claim.order.totalAmount,
    currency: "INR",
    attachedProviderOrderId: claim.attachedProviderOrderId,
  });
});
