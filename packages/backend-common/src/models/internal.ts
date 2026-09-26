import { Types } from "mongoose";
import { Order, Restaurant, Rider, User } from "./schemas.js";

// ─── Internal data functions (shared) ────────────────────────
// The DB logic that used to live behind each service's internal HTTP
// routes / Lambda worker actions, now exported as plain functions so
// admin-service can execute them directly (no cross-service hop).
// The owning services re-use the same functions for their own internal
// routes, so a rule like "pending = isVerified:false" is defined once
// and can't drift between caller and owner.
//
// Errors carry an HTTP `status` so callers using tryCatchStatus keep
// real 400/404 semantics instead of collapsing everything to 500.

export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const assertObjectId = (id: string) => {
  if (!Types.ObjectId.isValid(id)) {
    throw new HttpError(400, "Invalid id");
  }
};

// ─── Users (owned by auth-service) ───────────────────────────

export interface ListUsersParams {
  role?: string;
  limit?: number;
}

export const listUsers = async (params?: ListUsersParams) => {
  const filter = params?.role ? { role: params.role } : {};
  const limit = params?.limit ? Math.min(params.limit, 500) : 500;

  const users = await User.find(filter)
    .select("-password -refreshTokens")
    .sort({ createdAt: -1 })
    .limit(limit);

  return { count: users.length, users };
};

export const getUserStats = async () => {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [total, newThisMonth] = await Promise.all([
    User.countDocuments({}),
    User.countDocuments({ createdAt: { $gte: monthStart } }),
  ]);

  return { total, newThisMonth };
};

// ─── Riders (owned by rider-service) ─────────────────────────

export const listRiders = async (status?: unknown) => {
  if (status === "pending") {
    const riders = await Rider.find({ isVerified: false });
    return { count: riders.length, riders };
  }

  // Online first, then verified — for the admin roster view.
  const riders = await Rider.find({}).sort({ isAvailable: -1, isVerified: -1 });
  return { count: riders.length, riders };
};

export const verifyRiderById = async (id: string) => {
  assertObjectId(id);

  const rider = await Rider.findByIdAndUpdate(id, { isVerified: true }, { new: true });

  if (!rider) {
    throw new HttpError(404, "Rider not found");
  }

  return { message: "Rider verified", rider };
};

export const getRiderStats = async () => {
  const [total, verified, online] = await Promise.all([
    Rider.countDocuments({}),
    Rider.countDocuments({ isVerified: true }),
    Rider.countDocuments({ isAvailable: true, isVerified: true }),
  ]);

  return { total, verified, online, pending: total - verified };
};

// ─── Restaurants (owned by restaurant-service) ───────────────

export const listRestaurants = async (status?: unknown) => {
  if (status === "pending") {
    const restaurants = await Restaurant.find({ isVerified: false });
    return { count: restaurants.length, restaurants };
  }

  // Every restaurant — open ones first — for the admin roster view.
  const restaurants = await Restaurant.find({}).sort({ isOpen: -1, name: 1 });
  return { count: restaurants.length, restaurants };
};

export const verifyRestaurantById = async (id: string) => {
  assertObjectId(id);

  const restaurant = await Restaurant.findByIdAndUpdate(
    id,
    { isVerified: true },
    { new: true },
  );

  if (!restaurant) {
    throw new HttpError(404, "Restaurant not found");
  }

  return { message: "Restaurant verified", restaurant };
};

export const getRestaurantStats = async () => {
  const [total, verified, open] = await Promise.all([
    Restaurant.countDocuments({}),
    Restaurant.countDocuments({ isVerified: true }),
    Restaurant.countDocuments({ isOpen: true, isVerified: true }),
  ]);

  return { total, verified, open, pending: total - verified };
};

// ─── Orders (owned by restaurant-service) ────────────────────
// The revenue aggregations live with the orders data.

export const getOrderStats = async () => {
  const now = new Date();
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const [total, delivered, cancelled, active, revenueAgg, prevRevenueAgg, dailyAgg, topRestaurantsAgg] =
    await Promise.all([
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
  const monthRevenue = prevRevenueAgg.length ? prevRevenueAgg[0]?.total ?? 0 : 0;

  return {
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
  };
};
