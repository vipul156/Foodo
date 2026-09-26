import {
  startFanoutConsumer,
  makeFanoutPublisher,
} from "@foodo/backend-common/queue";
import { manager } from "./rabbitmq.js";
import { Rider } from "@foodo/backend-common/models";

// Room-targeted dashboard notifications ride the same fanout envelope
// realtime consumes: { event, room, payload }.
const publishRealtimeEvent = makeFanoutPublisher(manager);

// ─── Rider event consumer (compensations) ───────────────────
// The rider service OWNS rider state — nothing else writes it. Handler
// dispatch, topology, ack policy, retry+DLQ and reconnect re-attachment
// live in the shared startFanoutConsumer builder; this file provides the
// business logic per event:
//
//   rider.order_rejected — assignment fell through (order gone/taken/
//     expired); free the rider again (saga compensation).
//   order.cancelled — an order carrying this rider was cancelled;
//     free them (was PUT /api/rider/release/internal over HTTP).
//   order.delivered — the restaurant service confirmed the delivery
//     transition; free the rider so they can go back online (was the
//     HTTP response driving it in PUT /order/update).
//
// Every release is a CONDITIONAL update keyed to the order the rider is
// claimed by: a stale/delayed/redelivered event can never free a rider
// who already moved on to another order.
export const startRiderEventConsumer = () =>
  startFanoutConsumer(manager, {
    queueEnvVar: "RIDER_EVENTS_QUEUE",
    defaultQueue: "rider.rider_events",
    handlers: {
      "rider.order_rejected": async ({ payload }) => {
        if (!payload?.riderId) return;
        await freeRider({
          riderId: payload.riderId,
          orderId: payload.orderId,
          note: `order ${payload.orderId} not assignable`,
          // Assignment fell through — dashboard must clear the delivery.
          notify: { orderId: null, status: "cancelled" },
        });
      },

      "order.cancelled": async ({ payload }) => {
        if (!payload?.riderId) return;
        await freeRider({
          riderId: payload.riderId,
          orderId: payload.orderId,
          note: `order ${payload.orderId} cancelled`,
          notify: { orderId: null, status: "cancelled" },
        });
      },

      "order.delivered": async ({ payload }) => {
        if (!payload?.riderId) return;
        await freeRider({
          riderId: payload.riderId,
          orderId: payload.orderId,
          note: `order ${payload.orderId} delivered`,
          // Delivery completed — dashboard shows success, not a cancel.
          notify: { orderId: payload.orderId, status: "delivered" },
        });
      },
    },
  });

// ─── Shared conditional release (the one true free path) ────
// Flips the rider back ONLY if they are still claimed by THIS order and
// currently offline. All three events above funnel through here, so the
// idempotency semantics live in exactly one place.
async function freeRider({
  riderId,
  orderId,
  note,
  notify,
}: {
  riderId: string;
  orderId?: string;
  note: string;
  notify: { orderId: string | null; status: string };
}) {
  const rider = await Rider.findOneAndUpdate(
    orderId
      ? { _id: riderId, isAvailable: false, currentOrderId: orderId }
      : { _id: riderId, isAvailable: false },
    { isAvailable: true, currentOrderId: null, lastActive: new Date() },
    { new: true },
  );

  if (!rider) {
    // No match: rider doesn't exist, is already online, or already
    // claimed another order. All fine — stale event, idempotent no-op.
    console.log(`[COMPENSATE] skip — rider ${riderId} not claimable (${note})`);
    return;
  }

  // Rider dashboard learns the outcome — over the fanout exchange,
  // never over HTTP.
  publishRealtimeEvent("order:update", `user:${rider.userId}`, notify);
  console.log(`[COMPENSATE] rider ${rider._id} released (${note})`);
}
