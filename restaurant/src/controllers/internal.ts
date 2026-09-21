import { Types } from "mongoose";
import type { Request, Response } from "express";
import { tryCatch } from "../middlewares/trycatch.js";
import { Restaurant } from "../models/Restaurant.js";
import { Order } from "../models/Order.js";

// ─── Internal: Order Summary (dispatch enrichment) ──────────
// The ai-dispatch swarm needs item names (kitchen prep prediction) and
// the drop coordinates (batching + ETA) without scraping the whole
// order. Facts about THIS service's data are served HERE — no
// cross-service collection reads. GET /api/internal/orders/:id/summary
export const getOrderSummary = tryCatch(async (req, res) => {
  const { id } = req.params;

  if (!id || typeof id !== "string" || !Types.ObjectId.isValid(id)) {
    return res.status(400).json({ message: "Invalid order id" });
  }

  const order = await Order.findById(id).select(
    "restaurantId restaurantName items status paymentStatus deliveryAddress autoLocation",
  );

  if (!order) {
    return res.status(404).json({ message: "Order not found" });
  }

  return res.json({
    success: true,
    summary: {
      orderId: order._id,
      restaurantId: order.restaurantId,
      restaurantName: order.restaurantName,
      status: order.status,
      paymentStatus: order.paymentStatus,
      items: (order.items ?? []).map((i) => ({
        name: i.name,
        quantity: (i as { quauntity?: number; quantity?: number }).quauntity ?? 1,
      })),
      drop: order.deliveryAddress
        ? {
            latitude: order.deliveryAddress.latitude,
            longitude: order.deliveryAddress.longitude,
            formattedAddress: order.deliveryAddress.formattedAddress,
          }
        : null,
    },
  });
});

// ─── Internal: Batchable Orders (dispatch pairing pool) ─────
// Ready-for-rider orders at one restaurant, newest first, capped — the
// batching agent pairs co-located pickups/drops from this pool.
// GET /api/internal/orders/batchable?restaurantId=...&excludeOrderId=...
export const getBatchableOrders = tryCatch(async (req, res) => {
  const { restaurantId, excludeOrderId } = req.query;

  if (!restaurantId || !Types.ObjectId.isValid(String(restaurantId))) {
    return res.status(400).json({ message: "Valid restaurantId is required" });
  }

  const filter: Record<string, unknown> = {
    restaurantId: String(restaurantId),
    status: "ready_for_rider",
    paymentStatus: "paid",
  };
  if (excludeOrderId && Types.ObjectId.isValid(String(excludeOrderId))) {
    filter._id = { $ne: new Types.ObjectId(String(excludeOrderId)) };
  }

  const orders = await Order.find(filter)
    .sort({ createdAt: -1 })
    .limit(10)
    .select(
      "_id restaurantId restaurantName items deliveryAddress restaurantLocation status",
    );

  return res.json({
    success: true,
    count: orders.length,
    orders: orders.map((o) => ({
      orderId: o._id,
      restaurantId: o.restaurantId,
      items: (o.items ?? []).map((i) => i.name),
      pickup: o.restaurantLocation
        ? {
            latitude: o.restaurantLocation.latitude,
            longitude: o.restaurantLocation.longitude,
          }
        : null,
      drop: o.deliveryAddress
        ? {
            latitude: o.deliveryAddress.latitude,
            longitude: o.deliveryAddress.longitude,
          }
        : null,
    })),
  });
});

// ─── Internal: List Restaurants (admin) ─────────────────────
// The admin service reads restaurants through this endpoint instead of
// querying the collections raw. "Pending" is defined HERE, in the service
// that owns restaurants, so the rule can't drift elsewhere.
// GET /api/internal/restaurants?status=pending|all
export const listRestaurants = tryCatch(async (req: Request, res: Response) => {
  const status = req.query.status;
  if (status === "pending") {
    const restaurants = await Restaurant.find({ isVerified: false });
    return res.json({ count: restaurants.length, restaurants });
  }

  // Every restaurant — open ones first — for the admin roster view.
  const restaurants = await Restaurant.find({}).sort({ isOpen: -1, name: 1 });
  return res.json({ count: restaurants.length, restaurants });
});

// ─── Internal: Verify a Restaurant (admin) ──────────────────
// Verification is a mutation on this service's data, so it lives here.
// PATCH /api/internal/restaurants/:id/verify
export const verifyRestaurant = tryCatch(async (req: Request, res: Response) => {
  const { id } = req.params;

  if (typeof id !== "string") {
    return res.status(400).json({ message: "Invalid id" });
  }

  if (!Types.ObjectId.isValid(id)) {
    return res.status(400).json({ message: "Invalid id" });
  }

  const restaurant = await Restaurant.findByIdAndUpdate(
    id,
    { isVerified: true },
    { new: true },
  );

  if (!restaurant) {
    return res.status(404).json({ message: "Restaurant not found" });
  }

  return res.json({ message: "Restaurant verified", restaurant });
});

// ─── Internal: Restaurant Stats (admin analytics) ───────────
// GET /api/internal/restaurants/stats
export const getRestaurantStats = tryCatch(
  async (req: Request, res: Response) => {
    const [total, verified, open] = await Promise.all([
      Restaurant.countDocuments({}),
      Restaurant.countDocuments({ isVerified: true }),
      Restaurant.countDocuments({ isOpen: true, isVerified: true }),
    ]);

    return res.json({ total, verified, open, pending: total - verified });
  },
);

// ─── Internal: Order Stats (admin analytics) ────────────────
// The revenue aggregations live here because orders belong to this service.
// GET /api/internal/orders/stats
export const getOrderStats = tryCatch(async (req: Request, res: Response) => {
  const now = new Date();
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const [
    total,
    delivered,
    cancelled,
    active,
    revenueAgg,
    prevRevenueAgg,
    dailyAgg,
    topRestaurantsAgg,
  ] = await Promise.all([
    Order.countDocuments({}),
    Order.countDocuments({ status: "delivered" }),
    Order.countDocuments({ status: "cancelled" }),
    Order.countDocuments({
      status: { $nin: ["delivered", "cancelled"] },
    }),
    Order.aggregate([
      { $match: { paymentStatus: "paid", status: { $ne: "cancelled" } } },
      { $group: { _id: null, total: { $sum: "$totalAmount" } } },
    ]),
    Order.aggregate([
      {
        $match: {
          paymentStatus: "paid",
          status: { $ne: "cancelled" },
          createdAt: { $gte: prevMonthStart },
        },
      },
      { $group: { _id: null, total: { $sum: "$totalAmount" } } },
    ]),
    Order.aggregate([
      {
        $match: {
          paymentStatus: "paid",
          status: { $ne: "cancelled" },
          createdAt: {
            $gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
          },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
          },
          revenue: { $sum: "$totalAmount" },
          orders: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Order.aggregate([
      { $match: { paymentStatus: "paid", status: { $ne: "cancelled" } } },
      {
        $group: {
          _id: "$restaurantName",
          revenue: { $sum: "$totalAmount" },
          orders: { $sum: 1 },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: 5 },
    ]),
  ]);

  const totalRevenue = revenueAgg[0]?.total ?? 0;
  const monthRevenue = prevRevenueAgg.length
    ? prevRevenueAgg[0]?.total ?? 0
    : 0;

  return res.json({
    total,
    delivered,
    cancelled,
    active,
    revenue: {
      total: totalRevenue,
      thisMonth: monthRevenue > 0 ? monthRevenue : totalRevenue,
    },
    daily: dailyAgg.map((d: any) => ({
      date: d._id,
      revenue: d.revenue,
      orders: d.orders,
    })),
    topRestaurants: topRestaurantsAgg.map((r: any) => ({
      name: r._id,
      revenue: r.revenue,
      orders: r.orders,
    })),
  });
});
