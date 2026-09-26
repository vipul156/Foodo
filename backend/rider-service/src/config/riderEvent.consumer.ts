import type { Channel, ConsumeMessage } from "amqplib";
import { onChannelReady } from "./rabbitmq.js";
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
const onRiderEvent =
  (channel: Channel, queue: string) =>
  async (msg: ConsumeMessage | null): Promise<void> => {
    if (!msg) return;

    try {
      const { event, payload } = JSON.parse(msg.content.toString());

      if (event === "rider.order_rejected" && payload?.riderId) {
        // Conditional saga compensation: free the rider ONLY if they are
        // still claimed by the rejected order. A delayed/stale rejection
        // (rider already claimed a different order in the meantime) must
        // not flip their availability — that was a double-assignment race.
        const released = await Rider.findOneAndUpdate(
          {
            _id: payload.riderId,
            isAvailable: false,
            currentOrderId: payload.orderId,
          },
          { isAvailable: true, currentOrderId: null, lastActive: new Date() },
          { new: true },
        );

        if (released) {
          // Rider dashboard learns the order didn't land — same signal the
          // cancel path sends.
          await publishRiderEvent(
            "order:update",
            { orderId: null, status: "cancelled" },
            `user:${released.userId}`,
          );
          console.log(
            `[COMPENSATE] rider ${released._id} released (order ${payload.orderId} not assignable)`,
          );
        } else {
          console.log(
            `[COMPENSATE] skip — rider ${payload.riderId} no longer claimed by order ${payload.orderId}`,
          );
        }
      }
    } catch (error) {
      handleConsumeFailure(channel, msg, queue, error);
      return;
    }

    channel.ack(msg);
  };

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
