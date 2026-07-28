import { AuthRequest } from "../middlewares/isAuth.js";
import { tryCatch } from "../middlewares/trycatch.js";
import { Address } from "../models/Address.js";
import { Order } from "../models/Order.js";
import { Cart } from "../models/Cart.js";
import { Restaurant } from "../models/Restaurant.js";
import { IMenuItem } from "../models/MenuItem.js";
import axios from "axios";
import { publishEvent } from "../config/order.publisher.js";

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

  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

  const [longitude, latitude] = address.location.coordinates;

  const riderAmount = Math.ceil(distance) * 17;

  const order = await Order.create({
    userId: req.user._id.toString(),
    addressId: addressId.toString(),
    paymentMethod,
    restaurantId: restaurantId.toString(),
    restaurantName: restaurant.name,
    riderId: null,
    items: orderItems,
    subtotal,
    deliveryFee,
    platformFee,
    totalAmount,
    expiresAt,
    deliveryAddress: {
      formattedAddress: address.formatterAddress,
      mobile: address.mobile,
      latitude,
      longitude,
    },
    paymentStatus: "pending",
    status: "placed",
  });

  await Cart.deleteMany({ userId: req.user._id });

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

  await axios.post(
    `${process.env.REALTIME_SERVICE_URL}/api/v1/internal/emit`,
    {
      event: "order:update",
      room: `user:${order.userId}`,
      payload: {
        orderId: order._id,
        status: order.status,
      },
    },
    {
      headers: {
        "x-internal-key": process.env.INTERNAL_SERVICE_KEY,
      },
    },
  );

  if(status === "ready_for_rider") {
    console.log("Order is ready for rider",order._id)

    await publishEvent("order:ready_for_rider", {
      orderId: order._id,
      restaurantId: restaurant._id,
      location: restaurant.autoLocation,
    });
    
    console.log("Event published")
  }

  return res.status(200).json({
    message: "Order updated successfully",
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

  return res.status(200).json({
    success: true,
    order,
  });
});


export const assignOrderToRider = tryCatch(async (req: AuthRequest, res) => {
   if (req.headers["x-internal-key"] !== process.env.INTERNAL_SERVICE_KEY) {
    throw new Error("Forbidden");
  }

  const { orderId, riderId, riderName, riderPhone } = req.params;

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
    status: "rider_assigned",
  }, { new: true });

   await axios.post(
    `${process.env.REALTIME_SERVICE_URL}/api/v1/internal/emit`,
    {
      event: "order:rider_assigned",
      room: `restaurant:${orderUpdate?.restaurantId}`,
      payload: {order: orderUpdate},
    },
    {
      headers: {
        "x-internal-key": process.env.INTERNAL_SERVICE_KEY,
      },
    },
  );

  return res.status(200).json({
    success: true,
    order: orderUpdate,
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
    throw new Error("Forbidden");
  }

  const { orderId } = req.body;

  if (!orderId) {
    throw new Error("Order ID is required");
  }


  const order = await Order.findById(orderId);

  if(!order) {
    throw new Error("No order found");
  }

  if(order.status === "rider_assigned") {
    order.status = "picked_up";
    await order.save();

     await axios.post(
    `${process.env.REALTIME_SERVICE_URL}/api/v1/internal/emit`,
    {
      event: "order:rider_assigned",
      room: `user:${order.userId}`,
      payload: order,
    },
    {
      headers: {
        "x-internal-key": process.env.INTERNAL_SERVICE_KEY,
      },
    },
  );

  return res.json({
    success: true,
    message: "Order status updated successfully",
  });
  }

  if(order.status === "picked_up") {
    order.status = "delivered";
    await order.save();

     await axios.post(
    `${process.env.REALTIME_SERVICE_URL}/api/v1/internal/emit`,
    {
      event: "order:delivered",
      room: `user:${order.userId}`,
      payload: order,
    },
    {
      headers: {
        "x-internal-key": process.env.INTERNAL_SERVICE_KEY,
      },
    },
  );

  return res.json({
    success: true,
    message: "Order status updated successfully",
  });
  }
});