import type { Channel, ConsumeMessage } from "amqplib";
import { onChannelReady } from "./rabbitmq.js";
import {
  declareResilienceQueues,
  handleConsumeFailure,
} from "@foodo/backend-common/queue";
import { publishRiderEvent } from "./event.publisher.js";
import { Rider } from "@foodo/backend-common/models";

// ─── Rider event consumer (compensations) ───────────────────
// The rider service OWNS rider state — nothing else writes it. These
// consumers handle the fanout events that replaced the internal HTTP
// write endpoints:
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
const onRiderEvent =
  (channel: Channel, queue: string) =>
  async (msg: ConsumeMessage | null): Promise<void> => {
    if (!msg) return;

    try {
      const { event, payload } = JSON.parse(msg.content.toString());

      if (event === "rider.order_rejected" && payload?.riderId) {
        await freeRider({
          riderId: payload.riderId,
          orderId: payload.orderId,
          note: `order ${payload.orderId} not assignable`,
          // Assignment fell through — dashboard must clear the delivery.
          notify: { orderId: null, status: "cancelled" },
        });
      } else if (event === "order.cancelled" && payload?.riderId) {
        await freeRider({
          riderId: payload.riderId,
          orderId: payload.orderId,
          note: `order ${payload.orderId} cancelled`,
          notify: { orderId: null, status: "cancelled" },
        });
      } else if (event === "order.delivered" && payload?.riderId) {
        await freeRider({
          riderId: payload.riderId,
          orderId: payload.orderId,
          note: `order ${payload.orderId} delivered`,
          // Delivery completed — dashboard shows success, not a cancel.
          notify: { orderId: payload.orderId, status: "delivered" },
        });
      }
    } catch (error) {
      handleConsumeFailure(channel, msg, queue, error);
      return;
    }

    channel.ack(msg);
  };

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
  await publishRiderEvent("order:update", notify, `user:${rider.userId}`);
  console.log(`[COMPENSATE] rider ${rider._id} released (${note})`);
}

export const startRiderEventConsumer = () => {
  // Registered once; re-runs on EVERY fresh channel — consume
  // registrations die with the channel, so after a RabbitMQ restart the
  // consumer re-attaches automatically.
  onChannelReady(async (channel) => {
    const exchange = process.env.REALTIME_EXCHANGE || "order.status_changed";
    const queue = process.env.RIDER_EVENTS_QUEUE || "rider.rider_events";

    await channel.assertExchange(exchange, "fanout", { durable: true });
    await channel.assertQueue(queue, { durable: true });
    await channel.bindQueue(queue, exchange, "");
    await declareResilienceQueues(channel, queue);

    channel.consume(queue, onRiderEvent(channel, queue));

    console.log(`Rider consuming events from exchange "${exchange}"`);
  });
};
