import { ObjectId } from "mongodb";
import { tryCatch } from "./trycatch.js";
import {
  getRestaurantCollection,
  getRidersCollection,
  getUserCollection,
  getOrderCollection,
} from "../util/collection.js";

export const getPendingRestaurants = tryCatch(async (req, res) => {
  const restaurantCollection = await getRestaurantCollection();
  const restaurants = await restaurantCollection
    .find({ isVerified: false })
    .toArray();

  res.json({
    count: restaurants.length,
    restaurants,
  });
});

// Every restaurant on the platform — open ones first — so admins can
// see the full roster beyond the pending verification queue.
export const getAllRestaurants = tryCatch(async (req, res) => {
  const restaurantCollection = await getRestaurantCollection();
  const restaurants = await restaurantCollection
    .find({})
    .sort({ isOpen: -1, name: 1 })
    .toArray();

  res.json({
    count: restaurants.length,
    restaurants,
  });
});

export const getPendingRiders = tryCatch(async (req, res) => {
  const riderCollection = await getRidersCollection();
  const riders = await riderCollection.find({ isVerified: false }).toArray();

  res.json({
    count: riders.length,
    riders,
  });
});

// Every rider on the platform — online first, then by availability —
// so admins can see the full roster beyond the pending queue.
export const getAllRiders = tryCatch(async (req, res) => {
  const riderCollection = await getRidersCollection();
  const riders = await riderCollection
    .find({})
    .sort({ isAvailable: -1, isVerified: -1 })
    .toArray();

  res.json({
    count: riders.length,
    riders,
  });
});

// Every user account, newest first. Role filter via ?role=customer|seller|rider|admin.
export const getAllUsers = tryCatch(async (req, res) => {
  const userCollection = await getUserCollection();

  const role = req.query.role as string | undefined;
  const filter = role ? { role } : {};

  const users = await userCollection
    .find(filter, {
      projection: { password: 0, token: 0 },
    })
    .sort({ createdAt: -1 })
    .limit(500)
    .toArray();

  res.json({
    count: users.length,
    users,
  });
});

export const verifyRestaurant = tryCatch(async (req, res) => {
  const { id } = req.params;

  if (typeof id !== "string") {
    throw new Error("Invalid id");
  }

  if (!ObjectId.isValid(id)) {
    throw new Error("Invalid id");
  }

  const restaurantCollection = await getRestaurantCollection();
  await restaurantCollection.updateOne(
    { _id: new ObjectId(id) },
    { $set: { isVerified: true, updatedAt: new Date() } },
  );

  if (!restaurantCollection) {
    throw new Error("Restaurant not found");
  }
  
  res.json({ message: "Restaurant verified" });
});


export const verifyRider = tryCatch(async (req, res) => {
  const { id } = req.params;

  if (typeof id !== "string") {
    throw new Error("Invalid id");
  }

  if (!ObjectId.isValid(id)) {
    throw new Error("Invalid id");
  }

  const riderCollection = await getRidersCollection();
  await riderCollection.updateOne(
    { _id: new ObjectId(id) },
    { $set: { isVerified: true, updatedAt: new Date() } },
  );

  if (!riderCollection) {
    throw new Error("Rider not found");
  }
  
  res.json({ message: "Rider verified" });
});

// ─── Platform Stats (analytics) ──────────────────────────────
// Aggregates users, restaurants, riders and orders into the numbers
// the admin analytics page renders. All computed server-side so the
// client only receives the summary.
export const getPlatformStats = tryCatch(async (req, res) => {
  const [userCollection, restaurantCollection, riderCollection, orderCollection] =
    await Promise.all([
      getUserCollection(),
      getRestaurantCollection(),
      getRidersCollection(),
      getOrderCollection(),
    ]);

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const [
    totalUsers,
    newUsersThisMonth,
    totalRestaurants,
    verifiedRestaurants,
    openRestaurants,
    totalRiders,
    verifiedRiders,
    onlineRiders,
    totalOrders,
    deliveredOrders,
    cancelledOrders,
    activeOrders,
    revenueAgg,
    prevRevenueAgg,
    dailyAgg,
    topRestaurantsAgg,
  ] = await Promise.all([
    userCollection.countDocuments({}),
    userCollection.countDocuments({ createdAt: { $gte: monthStart } }),
    restaurantCollection.countDocuments({}),
    restaurantCollection.countDocuments({ isVerified: true }),
    restaurantCollection.countDocuments({ isOpen: true, isVerified: true }),
    riderCollection.countDocuments({}),
    riderCollection.countDocuments({ isVerified: true }),
    riderCollection.countDocuments({ isAvailable: true, isVerified: true }),
    orderCollection.countDocuments({}),
    orderCollection.countDocuments({ status: "delivered" }),
    orderCollection.countDocuments({ status: "cancelled" }),
    orderCollection.countDocuments({
      status: { $nin: ["delivered", "cancelled"] },
    }),
    orderCollection
      .aggregate([
        { $match: { paymentStatus: "paid", status: { $ne: "cancelled" } } },
        { $group: { _id: null, total: { $sum: "$totalAmount" } } },
      ])
      .toArray(),
    orderCollection
      .aggregate([
        {
          $match: {
            paymentStatus: "paid",
            status: { $ne: "cancelled" },
            createdAt: { $gte: prevMonthStart },
          },
        },
        { $group: { _id: null, total: { $sum: "$totalAmount" } } },
      ])
      .toArray(),
    orderCollection
      .aggregate([
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
      ])
      .toArray(),
    orderCollection
      .aggregate([
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
      ])
      .toArray(),
  ]);

  const totalRevenue = revenueAgg[0]?.total ?? 0;
  const monthRevenue = prevRevenueAgg.length
    ? prevRevenueAgg[0]?.total ?? 0
    : 0;

  res.json({
    users: { total: totalUsers, newThisMonth: newUsersThisMonth },
    restaurants: {
      total: totalRestaurants,
      verified: verifiedRestaurants,
      open: openRestaurants,
      pending: totalRestaurants - verifiedRestaurants,
    },
    riders: {
      total: totalRiders,
      verified: verifiedRiders,
      online: onlineRiders,
      pending: totalRiders - verifiedRiders,
    },
    orders: {
      total: totalOrders,
      delivered: deliveredOrders,
      cancelled: cancelledOrders,
      active: activeOrders,
    },
    revenue: {
      total: totalRevenue,
      thisMonth:
        monthRevenue > 0
          ? monthRevenue
          : totalRevenue,
      monthChange: null,
    },
    daily: dailyAgg.map((d) => ({
      date: d._id,
      revenue: d.revenue,
      orders: d.orders,
    })),
    topRestaurants: topRestaurantsAgg.map((r) => ({
      name: r._id,
      revenue: r.revenue,
      orders: r.orders,
    })),
  });
});