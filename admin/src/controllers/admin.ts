import { tryCatch } from "./trycatch.js";
import {
  AUTH_SERVICE,
  RESTAURANT_SERVICE,
  RIDER_SERVICE,
  internalGet,
  internalPatch,
} from "../util/internal.js";

// ─── Pending Restaurants ────────────────────────────────────
// Read-through: the restaurant service owns restaurants and defines what
// "pending" means. Admin just forwards the response shape the frontend
// expects (unchanged contract).
export const getPendingRestaurants = tryCatch(async (req, res) => {
  const data = await internalGet<{
    count: number;
    restaurants: unknown[];
  }>(RESTAURANT_SERVICE, "/restaurants", { params: { status: "pending" } });

  res.json({
    count: data.count,
    restaurants: data.restaurants,
  });
});

// Every restaurant on the platform — open ones first — so admins can
// see the full roster beyond the pending verification queue.
export const getAllRestaurants = tryCatch(async (req, res) => {
  const data = await internalGet<{
    count: number;
    restaurants: unknown[];
  }>(RESTAURANT_SERVICE, "/restaurants");

  res.json({
    count: data.count,
    restaurants: data.restaurants,
  });
});

// ─── Pending Riders ─────────────────────────────────────────
// The rider service owns riders and defines what "pending" means.
export const getPendingRiders = tryCatch(async (req, res) => {
  const data = await internalGet<{ count: number; riders: unknown[] }>(
    RIDER_SERVICE,
    "/riders",
    { params: { status: "pending" } },
  );

  res.json({
    count: data.count,
    riders: data.riders,
  });
});

// Every rider on the platform — online first, then by availability —
// so admins can see the full roster beyond the pending queue.
export const getAllRiders = tryCatch(async (req, res) => {
  const data = await internalGet<{ count: number; riders: unknown[] }>(
    RIDER_SERVICE,
    "/riders",
  );

  res.json({
    count: data.count,
    riders: data.riders,
  });
});

// ─── Users ──────────────────────────────────────────────────
// The auth service owns users and never exports credentials.
// Role filter via ?role=customer|seller|rider|admin.
export const getAllUsers = tryCatch(async (req, res) => {
  const role = req.query.role as string | undefined;

  const data = await internalGet<{ count: number; users: unknown[] }>(
    AUTH_SERVICE,
    "/users",
    { params: { role } },
  );

  res.json({
    count: data.count,
    users: data.users,
  });
});

// ─── Verification (writes via the owning services) ──────────
// The owning service validates the id (400) and 404s unknown ids — admin
// no longer needs to know the ObjectId representation at all.
export const verifyRestaurant = tryCatch(async (req, res) => {
  const { id } = req.params;

  if (typeof id !== "string") {
    throw new Error("Invalid id");
  }

  await internalPatch(
    RESTAURANT_SERVICE,
    `/restaurants/${encodeURIComponent(id)}/verify`,
  );

  res.json({ message: "Restaurant verified" });
});

export const verifyRider = tryCatch(async (req, res) => {
  const { id } = req.params;

  if (typeof id !== "string") {
    throw new Error("Invalid id");
  }

  await internalPatch(
    RIDER_SERVICE,
    `/riders/${encodeURIComponent(id)}/verify`,
  );

  res.json({ message: "Rider verified" });
});

// ─── Platform Stats (analytics) ─────────────────────────────
// Each block is computed by the service that owns the data — admin only
// joins the four summaries for the analytics page. The aggregation logic
// (active orders, revenue windows, top restaurants) can no longer drift
// between services because it exists in exactly one place.
export const getPlatformStats = tryCatch(async (req, res) => {
  const [users, restaurants, riders, orders] = await Promise.all([
    internalGet<{ total: number; newThisMonth: number }>(
      AUTH_SERVICE,
      "/users/stats",
    ),
    internalGet<{
      total: number;
      verified: number;
      open: number;
      pending: number;
    }>(RESTAURANT_SERVICE, "/restaurants/stats"),
    internalGet<{
      total: number;
      verified: number;
      online: number;
      pending: number;
    }>(RIDER_SERVICE, "/riders/stats"),
    internalGet<{
      total: number;
      delivered: number;
      cancelled: number;
      active: number;
      revenue: { total: number; thisMonth: number };
      daily: { date: string; revenue: number; orders: number }[];
      topRestaurants: { name: string; revenue: number; orders: number }[];
    }>(RESTAURANT_SERVICE, "/orders/stats"),
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
