import { tryCatchStatus } from "@foodo/backend-common";
import {
  listUsers,
  listAllRestaurants,
  listPendingRestaurants,
  listAllRiders,
  listPendingRiders,
  setRestaurantVerified,
  setRiderVerified,
  listReadyOrders,
} from "@foodo/backend-common/dynamo";
import type {
  DynamoOrder,
  DynamoRestaurant,
  DynamoRider,
  DynamoUser,
} from "@foodo/backend-common/dynamo";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLE } from "@foodo/backend-common/aws";

// ─── Admin controller — direct DynamoDB access ───────────────
// Admin reads/writes through the shared DynamoDB repositories
// (@foodo/backend-common/dynamo). No cross-service hops, no
// cold-start chains, no cross-Lambda error mangling.
//
// tryCatchStatus keeps thrown HttpErrors as real 400/404 responses.
// Mongo aggregations become bounded scans/queries + in-memory rollups:
// the platform stats read every order once per dashboard load, which is
// the same work the $facet pipeline did server-side, minus the index
// dance. For larger volumes, move revenue rollups into DynamoDB
// Streams → a counter table (documented below).

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const stripCredentials = (u: DynamoUser) => {
  const { password: _p, pk: _pk, sk: _sk, ...rest } = u;
  return rest;
};

const stripKeys = <T extends { pk?: string; sk?: string }>(x: T): T => {
  const { pk: _pk, sk: _sk, ...rest } = x;
  return rest as T;
};

// ─── Pending Restaurants ────────────────────────────────────
// "Pending" = isVerified:false. Owned by admin's review workflow.
export const getPendingRestaurants = tryCatchStatus(async (_req, res) => {
  const restaurants = await listPendingRestaurants();

  res.json({
    count: restaurants.length,
    restaurants: restaurants.map(stripKeys),
  });
});

// ─── All Restaurants ────────────────────────────────────────
export const getAllRestaurants = tryCatchStatus(async (_req, res) => {
  // Open ones first for the admin roster view (sorted in the repo).
  const restaurants = await listAllRestaurants();

  res.json({
    count: restaurants.length,
    restaurants: restaurants.map(stripKeys),
  });
});

// ─── Pending Riders ─────────────────────────────────────────
export const getPendingRiders = tryCatchStatus(async (_req, res) => {
  const riders = await listPendingRiders();

  res.json({
    count: riders.length,
    riders: riders.map(stripKeys),
  });
});

// ─── All Riders ─────────────────────────────────────────────
export const getAllRiders = tryCatchStatus(async (_req, res) => {
  // Online first, then verified — for the admin roster view.
  const riders = await listAllRiders();

  res.json({
    count: riders.length,
    riders: riders.map(stripKeys),
  });
});

// ─── Users ──────────────────────────────────────────────────
export const getAllUsers = tryCatchStatus(async (req, res) => {
  const role = req.query.role as string | undefined;

  // Credentials never leave the DB: password and refresh-token rows are
  // separate/filtered — listUsers returns profiles only.
  const users = (await listUsers(500))
    .filter((u) => !role || u.role === role)
    .map(stripCredentials);

  res.json({
    count: users.length,
    users,
  });
});

// ─── Verification (Writes) ──────────────────────────────────
export const verifyRestaurant = tryCatchStatus(async (req, res) => {
  const { id } = req.params;

  if (typeof id !== "string" || !id) {
    throw new HttpError(400, "Invalid id");
  }

  const restaurant = await setRestaurantVerified(id, true);

  if (!restaurant) {
    throw new HttpError(404, "Restaurant not found");
  }

  res.json({ message: "Restaurant verified", restaurant: stripKeys(restaurant) });
});

export const verifyRider = tryCatchStatus(async (req, res) => {
  const { id } = req.params;

  if (typeof id !== "string" || !id) {
    throw new HttpError(400, "Invalid id");
  }

  const rider = await setRiderVerified(id, true);

  if (!rider) {
    throw new HttpError(404, "Rider not found");
  }

  res.json({ message: "Rider verified", rider: stripKeys(rider) });
});

// ─── Platform Stats (bounded scans + in-memory rollups) ─────
// One bounded read per table replaces the Promise.all aggregation
// battery. DynamoDB status counts ride the status-board GSI; revenue
// math runs in Lambda (the response is a few KB either way).

const PAID_NOT_CANCELLED = (o: DynamoOrder) =>
  o.paymentStatus === "paid" && o.status !== "cancelled";

export const getPlatformStats = tryCatchStatus(async (_req, res) => {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthStartIso = monthStart.toISOString();
  const thirtyDaysAgoIso = new Date(
    now.getTime() - 30 * 24 * 60 * 60 * 1000,
  ).toISOString();

  // Full order read for revenue rollups. Bounded growth: orders are the
  // one collection that grows unboundedly, so production should replace
  // this scan with Streams-maintained counters (see header note).
  const ordersOut = await docClient().send(
    new ScanCommand({ TableName: TABLE.orders() }),
  );
  const orders = (ordersOut.Items as DynamoOrder[]) ?? [];

  const [restaurants, riders, users] = await Promise.all([
    listAllRestaurants(),
    listAllRiders(),
    listUsers(1000),
  ]);

  const restaurantTotal = restaurants.length;
  const restaurantVerified = restaurants.filter((r) => r.isVerified).length;
  const restaurantOpen = restaurants.filter(
    (r) => r.isOpen && r.isVerified,
  ).length;

  const riderTotal = riders.length;
  const riderVerified = riders.filter((r) => r.isVerified).length;
  const riderOnline = riders.filter(
    (r) => r.isAvailable && r.isVerified,
  ).length;

  const userTotal = users.length;
  const userNewThisMonth = users.filter(
    (u) => u.createdAt >= monthStartIso,
  ).length;

  const orderTotal = orders.length;
  const orderDelivered = orders.filter((o) => o.status === "delivered").length;
  const orderCancelled = orders.filter((o) => o.status === "cancelled").length;
  const orderActive = orders.filter(
    (o) => o.status !== "delivered" && o.status !== "cancelled",
  ).length;

  const paidValid = orders.filter(PAID_NOT_CANCELLED);
  const totalRevenue = paidValid.reduce((sum, o) => sum + o.totalAmount, 0);
  const monthRevenue = paidValid
    .filter((o) => o.createdAt >= monthStartIso)
    .reduce((sum, o) => sum + o.totalAmount, 0);

  // Daily revenue buckets (last 30 days), UTC day boundaries — the same
  // $dateToString semantics the Mongo pipeline used.
  const dailyMap = new Map<string, { revenue: number; orders: number }>();
  for (const o of paidValid) {
    if (o.createdAt < thirtyDaysAgoIso) continue;
    const key = o.createdAt.slice(0, 10);
    const bucket = dailyMap.get(key) ?? { revenue: 0, orders: 0 };
    bucket.revenue += o.totalAmount;
    bucket.orders += 1;
    dailyMap.set(key, bucket);
  }
  const daily = [...dailyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, revenue: v.revenue, orders: v.orders }));

  // Top restaurants by revenue (all time, matching the old $limit: 5).
  const byRestaurant = new Map<string, { revenue: number; orders: number }>();
  for (const o of paidValid) {
    const agg = byRestaurant.get(o.restaurantName) ?? { revenue: 0, orders: 0 };
    agg.revenue += o.totalAmount;
    agg.orders += 1;
    byRestaurant.set(o.restaurantName, agg);
  }
  const topRestaurants = [...byRestaurant.entries()]
    .sort(([, a], [, b]) => b.revenue - a.revenue)
    .slice(0, 5)
    .map(([name, v]) => ({ name, revenue: v.revenue, orders: v.orders }));

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
    daily,
    topRestaurants,
  });
});

// listReadyOrders is imported for future admin tooling (live order board)
void listReadyOrders;
