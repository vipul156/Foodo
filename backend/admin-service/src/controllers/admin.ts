import { Types } from "mongoose";
import { tryCatchStatus } from "@foodo/backend-common";
import {
  Order,
  Restaurant,
  Rider,
  User,
} from "@foodo/backend-common/models";

// ─── Admin controller — direct DB access ─────────────────────
// Admin reads/writes the shared collections through the shared schemas
// (@foodo/backend-common/models). No cross-service hops: fewer requests,
// no cold-start chains, no cross-Lambda error mangling.
//
// These queries live HERE because admin is their only consumer. The
// only genuinely shared part — the schemas themselves — stays in
// backend-common; everything below is admin presentation/analytics
// logic (shapes like `revenue.thisMonth` are the admin dashboard's
// contract, not domain rules).
//
// tryCatchStatus keeps thrown HttpErrors as real 400/404 responses.

class HttpError extends Error {
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

// ─── Pending Restaurants ────────────────────────────────────
// "Pending" = isVerified:false. Owned by admin's review workflow.
export const getPendingRestaurants = tryCatchStatus(async (req, res) => {
  const restaurants = await Restaurant.find({ isVerified: false });

  res.json({
    count: restaurants.length,
    restaurants,
  });
});

// ─── All Restaurants ────────────────────────────────────────
export const getAllRestaurants = tryCatchStatus(async (req, res) => {
  // Open ones first for the admin roster view.
  const restaurants = await Restaurant.find({}).sort({ isOpen: -1, name: 1 });

  res.json({
    count: restaurants.length,
    restaurants,
  });
});

// ─── Pending Riders ─────────────────────────────────────────
export const getPendingRiders = tryCatchStatus(async (req, res) => {
  const riders = await Rider.find({ isVerified: false });

  res.json({
    count: riders.length,
    riders,
  });
});

// ─── All Riders ─────────────────────────────────────────────
export const getAllRiders = tryCatchStatus(async (req, res) => {
  // Online first, then verified — for the admin roster view.
  const riders = await Rider.find({}).sort({ isAvailable: -1, isVerified: -1 });

  res.json({
    count: riders.length,
    riders,
  });
});

// ─── Users ──────────────────────────────────────────────────
export const getAllUsers = tryCatchStatus(async (req, res) => {
  const role = req.query.role as string | undefined;

  // Credentials never leave the DB: password is select:false in the
  // shared schema, refresh-token hashes are excluded explicitly.
  const filter = role ? { role } : {};
  const users = await User.find(filter)
    .select("-password -refreshTokens")
    .sort({ createdAt: -1 })
    .limit(500);

  res.json({
    count: users.length,
    users,
  });
});

// ─── Verification (Writes) ──────────────────────────────────
export const verifyRestaurant = tryCatchStatus(async (req, res) => {
  const { id } = req.params;

  if (typeof id !== "string") {
    throw new HttpError(400, "Invalid id");
  }
  assertObjectId(id);

  const restaurant = await Restaurant.findByIdAndUpdate(
    id,
    { isVerified: true },
    { new: true },
  );

  if (!restaurant) {
    throw new HttpError(404, "Restaurant not found");
  }

  res.json({ message: "Restaurant verified", restaurant });
});

export const verifyRider = tryCatchStatus(async (req, res) => {
  const { id } = req.params;

  if (typeof id !== "string") {
    throw new HttpError(400, "Invalid id");
  }
  assertObjectId(id);

  const rider = await Rider.findByIdAndUpdate(
    id,
    { isVerified: true },
    { new: true },
  );

  if (!rider) {
    throw new HttpError(404, "Rider not found");
  }

  res.json({ message: "Rider verified", rider });
});

// ─── Platform Stats (Parallel Aggregation) ──────────────────
export const getPlatformStats = tryCatchStatus(async (req, res) => {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const [
    userTotal,
    userNewThisMonth,
    restaurantTotal,
    restaurantVerified,
    restaurantOpen,
    riderTotal,
    riderVerified,
    riderOnline,
    orderTotal,
    orderDelivered,
    orderCancelled,
    orderActive,
    revenueAgg,
    prevRevenueAgg,
    dailyAgg,
    topRestaurantsAgg,
  ] = await Promise.all([
    // ─── Users ──────────────────────────────────────────────
    User.countDocuments({}),
    User.countDocuments({ createdAt: { $gte: monthStart } }),

    // ─── Restaurants ────────────────────────────────────────
    Restaurant.countDocuments({}),
    Restaurant.countDocuments({ isVerified: true }),
    Restaurant.countDocuments({ isOpen: true, isVerified: true }),

    // ─── Riders ─────────────────────────────────────────────
    Rider.countDocuments({}),
    Rider.countDocuments({ isVerified: true }),
    Rider.countDocuments({ isAvailable: true, isVerified: true }),

    // ─── Orders ─────────────────────────────────────────────
    Order.countDocuments({}),
    Order.countDocuments({ status: "delivered" }),
    Order.countDocuments({ status: "cancelled" }),
    Order.countDocuments({
      status: { $nin: ["delivered", "cancelled"] },
    }),

    // ─── Revenue aggregations ───────────────────────────────
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

  res.json({
    users: {
      total: userTotal,
      newThisMonth: userNewThisMonth,
    },
    restaurants: {
      total: restaurantTotal,
      verified: restaurantVerified,
      open: restaurantOpen,
      pending: restaurantTotal - restaurantVerified,
    },
    riders: {
      total: riderTotal,
      verified: riderVerified,
      online: riderOnline,
      pending: riderTotal - riderVerified,
    },
    orders: {
      total: orderTotal,
      delivered: orderDelivered,
      cancelled: orderCancelled,
      active: orderActive,
    },
    revenue: {
      total: totalRevenue,
      thisMonth: monthRevenue > 0 ? monthRevenue : totalRevenue,
      monthChange: null,
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
