import { getChannel } from "./rabbitmq.js";
import {
  declareResilienceQueues,
  handleConsumeFailure,
} from "./queue.resilience.js";
import { publishRiderEvent } from "./event.publisher.js";
import { Rider } from "../model/Rider.js";

// ─── Rider event consumer (compensation) ────────────────────
// Accept is now async: the rider claims itself and returns 200, and the
// restaurant service assigns the order in the background. If the
// assignment is impossible (order already taken, cancelled, or expired),
// the restaurant service publishes rider.order_rejected and THIS consumer
// is the saga compensation — it frees the rider again and tells the
// rider's dashboard.
export const startRiderEventConsumer = async () => {
  const channel = getChannel();

  if (!channel) {
    console.error(
      "RabbitMQ channel not available, rider event consumer not started",
    );
    return;
  }

  const exchange = process.env.REALTIME_EXCHANGE || "order.status_changed";
  const queue = process.env.RIDER_EVENTS_QUEUE || "rider.rider_events";

  await channel.assertExchange(exchange, "fanout", { durable: true });
  await channel.assertQueue(queue, { durable: true });
  await channel.bindQueue(queue, exchange, "");
  await declareResilienceQueues(channel, queue);

  channel.consume(queue, async (msg) => {
    if (!msg) return;

    try {
      const { event, payload } = JSON.parse(msg.content.toString());

      if (event === "rider.order_rejected" && payload?.riderId) {
        // Free the rider so they can take other orders
        const rider = await Rider.findById(payload.riderId);

        if (rider && !rider.isAvailable) {
          rider.isAvailable = true;
          rider.lastActive = new Date();
          await rider.save();

          // Rider dashboard learns the order didn't land — same signal the
          // cancel path sends.
          publishRiderEvent(
            "order:update",
            { orderId: null, status: "cancelled" },
            `user:${rider.userId}`,
          );
          console.log(
            `[COMPENSATE] rider ${rider._id} released (order ${payload.orderId} not assignable)`,
          );
        }
      }
    } catch (error) {
      handleConsumeFailure(channel, msg, queue, error);
      return;
    }

    channel.ack(msg);
  });

  console.log(`Rider consuming events from exchange "${exchange}"`);
};
