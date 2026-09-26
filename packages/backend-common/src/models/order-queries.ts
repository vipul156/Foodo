import mongoose from "mongoose";
import { Order, Restaurant } from "./schemas.js";

// ─── Shared read-only order queries ──────────────────────────
// Pure reads over the shared schemas, used IN-PROCESS by more than one
// service (rider-service dashboards, utils-service reconciliation).
// Sharing them here means the query + sort + payment-status rule is
// written once — every consumer gets identical results without an HTTP
// round-trip to the restaurant service.
//
// Writes are deliberately NOT here: order mutations stay owned by
// restaurant-service (HTTP for rider status updates, RMQ events for
// payment fulfillment), so write paths keep their single owner.

/**
 * The rider's one active (not yet delivered) order, with the
 * restaurant populated for the pickup view. Drives "current delivery"
 * dashboards. Read-only.
 */
export const findCurrentOrderForRider = async (riderId: string) => {
  return Order.findOne({
    riderId,
    status: { $ne: "delivered" },
  }).populate("restaurantId");
};

/**
 * Delivered + paid orders for a rider, newest first — the Earnings and
 * History pages. Read-only.
 */
export const findDeliveryHistoryForRider = async (
  riderId: string,
): Promise<{ count: number; orders: unknown[] }> => {
  const orders = await Order.find({
    riderId,
    status: "delivered",
    paymentStatus: "paid",
  }).sort({ createdAt: -1 });

  return { count: orders.length, orders };
};

/**
 * Paid ready_for_rider orders at restaurants within 10km of the given
 * point — the rider's "available orders" list (fallback for riders who
 * logged in after the socket broadcast). Read-only.
 */
export const findReadyOrdersNearRider = async (
  latitude: number,
  longitude: number,
): Promise<{ count: number; orders: unknown[] }> => {
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
      $in: nearbyRestaurants.map((r) =>
        (r._id as mongoose.Types.ObjectId).toString(),
      ),
    },
  }).sort({ createdAt: 1 });

  return { count: orders.length, orders };
};

/**
 * Reconciliation candidates: pending orders whose payment intent was
 * initiated longer than `olderThanMinutes` ago and never became paid.
 * The utils-service payment audit job reads these and asks the provider
 * for the truth; captured money is healed via the RMQ payment-success
 * event (idempotent), never via a direct write. Read-only.
 */
export const findReconciliationCandidates = async (olderThanMinutes = 20) => {
  const since = new Date(Date.now() - olderThanMinutes * 60 * 1000);

  return Order.find({
    paymentStatus: "pending",
    "paymentIntent.providerOrderId": { $exists: true, $ne: null },
    "paymentIntent.initiatedAt": { $lte: since },
  })
    .limit(100)
    .select("_id paymentIntent paymentStatus totalAmount")
    .lean();
};
