import { getChannel } from "./rabbitmq.js";
import {
  declareResilienceQueues,
  handleConsumeFailure,
} from "./queue.resilience.js";
import { publishRealtimeEvent } from "./realtime.publisher.js";
import { assignRiderToOrder } from "../controllers/order.js";

// ─── Rider event consumer (assignment) ──────────────────────
// Rider acceptance is async: the rider claims itself and returns 200
// instantly; THIS consumer performs the atomic order assignment in the
// background and pushes the socket updates over the fanout exchange.
// If the assignment is impossible, it publishes rider.order_rejected —
// the rider service's consumer compensates by freeing the rider.
export const startRiderEventConsumer = async () => {
  const channel = getChannel();

  if (!channel) {
    console.error(
      "RabbitMQ channel not available, rider event consumer not started",
    );
    return;
  }

  const exchange = process.env.REALTIME_EXCHANGE || "order.status_changed";
  const queue = process.env.RIDER_EVENTS_QUEUE || "restaurant.rider_events";

  await channel.assertExchange(exchange, "fanout", { durable: true });
  await channel.assertQueue(queue, { durable: true });
  await channel.bindQueue(queue, exchange, "");
  await declareResilienceQueues(channel, queue);

  channel.consume(queue, async (msg) => {
    if (!msg) return;

    try {
      const { event, payload } = JSON.parse(msg.content.toString());

      if (event === "rider.order_accepted" && payload?.orderId && payload?.riderId) {
        const result = await assignRiderToOrder(payload);

        if (!result.success) {
          // Order gone/taken/expired — ask the rider service to free the
          // rider (its consumer is the saga compensation).
          publishRealtimeEvent("rider.order_rejected", "", {
            riderId: payload.riderId,
            riderUserId: payload.riderUserId,
            orderId: payload.orderId,
          });
          console.log(
            `[COMPENSATE] order ${payload.orderId} not assignable — rider ${payload.riderId} release requested`,
          );
        }
      }
    } catch (error) {
      // DB blips retry with backoff, then DLQ + alert
      handleConsumeFailure(channel, msg, queue, error);
      return;
    }

    channel.ack(msg);
  });

  console.log(`Restaurant consuming rider events from exchange "${exchange}"`);
};
