import { Types } from "mongoose";
import type { Request, Response } from "express";
import { tryCatch } from "../middlewares/trycatch.js";
import { Restaurant } from "../models/Restaurant.js";
import { Order } from "../models/Order.js";

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
