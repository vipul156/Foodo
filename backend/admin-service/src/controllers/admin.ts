import { tryCatchStatus } from "@foodo/backend-common";
import {
  listRestaurants,
  verifyRestaurantById,
  listRiders,
  verifyRiderById,
  listUsers,
  getUserStats,
  getRiderStats,
  getRestaurantStats,
  getOrderStats,
} from "@foodo/backend-common/models";

// ─── Admin controller — direct DB access ─────────────────────
// Admin reads/writes the shared collections through the same schema +
// data functions the owning services use (@foodo/backend-common/models).
// No more Lambda round-trips to auth/restaurant/rider internal workers:
// fewer hops, no cold-start chains, no cross-Lambda error mangling.
// Business rules ("pending = isVerified:false") stay defined once in
// the shared package, so they can't drift from the owning services.

// ─── Pending Restaurants ────────────────────────────────────
export const getPendingRestaurants = tryCatchStatus(async (req, res) => {
  const data = await listRestaurants("pending");

  res.json({
    count: data.count,
    restaurants: data.restaurants,
  });
});

// ─── All Restaurants ────────────────────────────────────────
export const getAllRestaurants = tryCatchStatus(async (req, res) => {
  const data = await listRestaurants();

  res.json({
    count: data.count,
    restaurants: data.restaurants,
  });
});

// ─── Pending Riders ─────────────────────────────────────────
export const getPendingRiders = tryCatchStatus(async (req, res) => {
  const data = await listRiders("pending");

  res.json({
    count: data.count,
    riders: data.riders,
  });
});

// ─── All Riders ─────────────────────────────────────────────
export const getAllRiders = tryCatchStatus(async (req, res) => {
  const data = await listRiders();

  res.json({
    count: data.count,
    riders: data.riders,
  });
});

// ─── Users ──────────────────────────────────────────────────
export const getAllUsers = tryCatchStatus(async (req, res) => {
  const role = req.query.role as string | undefined;

  // exactOptionalPropertyTypes: pass the key only when present
  const data = await listUsers(role ? { role } : {});

  res.json({
    count: data.count,
    users: data.users,
  });
});

// ─── Verification (Writes) ──────────────────────────────────
export const verifyRestaurant = tryCatchStatus(async (req, res) => {
  const { id } = req.params;

  if (typeof id !== "string") {
    throw new Error("Invalid id");
  }

  await verifyRestaurantById(id);

  res.json({ message: "Restaurant verified" });
});

export const verifyRider = tryCatchStatus(async (req, res) => {
  const { id } = req.params;

  if (typeof id !== "string") {
    throw new Error("Invalid id");
  }

  await verifyRiderById(id);

  res.json({ message: "Rider verified" });
});

// ─── Platform Stats (Parallel Aggregation) ──────────────────
export const getPlatformStats = tryCatchStatus(async (req, res) => {
  const [users, restaurants, riders, orders] = await Promise.all([
    getUserStats(),
    getRestaurantStats(),
    getRiderStats(),
    getOrderStats(),
  ]);

  res.json({
    users,
    restaurants,
    riders,
    orders: {
      total: orders.total,
      delivered: orders.delivered,
      cancelled: orders.cancelled,
      active: orders.active,
    },
    revenue: {
      total: orders.revenue.total,
      thisMonth: orders.revenue.thisMonth,
      monthChange: null,
    },
    daily: orders.daily,
    topRestaurants: orders.topRestaurants,
  });
});
