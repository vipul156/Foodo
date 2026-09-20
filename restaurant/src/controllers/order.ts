import mongoose from "mongoose";
import { AuthRequest } from "../middlewares/isAuth.js";
import { tryCatch } from "../middlewares/trycatch.js";
import { Address } from "../models/Address.js";
import { Order } from "../models/Order.js";
import { Cart } from "../models/Cart.js";
import { Restaurant } from "../models/Restaurant.js";
import { MenuItem, IMenuItem } from "../models/MenuItem.js";
import axios from "axios";
import { publishEvent } from "../config/order.publisher.js";
import { publishRealtimeEvent } from "../config/realtime.publisher.js";

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
  axios
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

  const { addressId, paymentMethod, distance } = req.body;

  if (!paymentMethod) {
    throw new Error("Payment method is required");
  }

  if (!addressId) {
    throw new Error("Address is required");
  }

  const address = await Address.findById({
    _id: addressId,
    userId: req.user._id,
  });

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
      itemId: item._id.toString(),
      name: item.name,
      price: item.price,
      quantity: cart.quantity,
    };
  });

  const deliveryFee = subtotal < 250 ? 49 : 0;
  const platformFee = 7;
  const totalAmount = subtotal + deliveryFee + platformFee;
  const orderDistance = Number(distance) || 5;
  const riderAmount = Math.ceil(orderDistance) * 17;

  // Online payments get 15 minutes to complete before the order expires.
  // COD has no payment window, so it never carries the expiry TTL.
  const isCod = paymentMethod === "cod";
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

  const [longitude, latitude] = address.location.coordinates;

  const order = await Order.create({
    userId: req.user._id.toString(),
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
  });

  if (isCod) {
    // Cash on delivery is a final, confirmed order — clear the cart now
    // and tell everyone. Online payments clear the cart in the payment
    // consumer only after the gateway confirms the money.
    await Cart.deleteMany({ userId: req.user._id });

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

export const fetchRestaurantOrders = tryCatch(async (req: AuthRequest, res) => {
  const user = req.user;

  const { restaurantId } = req.params;

  if (!user) {
    throw new Error("Unauthorized");
  }

  if (!restaurantId) {
    throw new Error("Restaurant ID is required");
  }

  const limit = req.query.limit ? Number(req.query.limit) : 0;

  const orders = await Order.find({ restaurantId, paymentStatus: "paid" })
    .sort({ createdAt: -1 })
    .limit(limit);

  return res.status(200).json({
    success: true,
    count: orders.length,
    orders,
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


export const assignOrderToRider = tryCatch(async (req: AuthRequest, res) => {
   if (req.headers["x-internal-key"] !== process.env.INTERNAL_SERVICE_KEY) {
    throw new Error("Forbidden");
  }

  const { orderId, riderId, riderName, riderPhone, riderPicture } = req.body;

  if (!orderId) {
    throw new Error("Order ID is required");
  }

  const order = await Order.findById(orderId);
  

  if (order?.riderId !== null) {
    throw new Error("Order already assigned to a rider");
  }

  const orderUpdate = await Order.findByIdAndUpdate(
    {_id: orderId, riderId: null}, {
    riderId,
    riderName,
    riderPhone,
    riderPicture: riderPicture || null,
    status: "rider_assigned",
  }, { new: true });

  if (!orderUpdate) {
    return res.status(409).json({
      success: false,
      message: "Order not found or already assigned",
    });
  }

  // Restaurant board (restaurantId room) — restaurantId is an ObjectId,
  // the restaurant room expects the same id the socket joined with.
  notifyRealtime("order:rider_assigned", `restaurant:${orderUpdate.restaurantId}`, {
    order: orderUpdate,
  });
  // Seller's own socket (user room) + customer's "rider is on the way"
  notifyRealtime("order:rider_assigned", `user:${orderUpdate.userId}`, {
    order: orderUpdate,
  });

  const assignedRestaurant = await Restaurant.findById(orderUpdate.restaurantId);
  if (assignedRestaurant) {
    notifyRealtime("order:rider_assigned", `user:${assignedRestaurant.ownerId}`, {
      order: orderUpdate,
    });
  }

  return res.status(200).json({
    success: true,
    order: orderUpdate,
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
