import { startQueueConsumer } from "@foodo/backend-common/queue";
import { manager } from "./rabbitmq.js";
import { Rider } from "@foodo/backend-common/models";

// ─── Order-ready consumer (rider matching) ──────────────────
// Queue attach, { type, data } envelope parsing, ack policy, retry+DLQ
// and reconnect re-attachment live in the shared startQueueConsumer
// builder — this file only provides the matching/notification logic.
export const startOrderReadyConsumer = () =>
  startQueueConsumer(manager, {
    queueEnvVar: "ORDER_QUEUE",
    defaultQueue: "order.events",
    onMessage: async (data: {
      type: string;
      data: { orderId: string; restaurantId: string; location: unknown };
    }) => {
      if (data?.type !== "order:ready_for_rider") {
        return;
      }

      const { orderId, restaurantId, location } = data.data;

      // Find available riders within 10km of the restaurant
      const riders = await Rider.find({
        isAvailable: true,
        isVerified: true,
        location: {
          $near: {
            $geometry: location,
            $maxDistance: 10000, // 10km in meters
          },
        },
      });

      console.log(
        `Found ${riders.length} available riders for order ${orderId}`,
      );

      if (riders.length === 0) {
        console.log("No riders available for order:", orderId);
        return;
      }

      // ─── Notify riders over the fanout exchange ─────────────
      // One publish per rider (same envelope realtime consumes), no
      // HTTP hop to the socket tier. Realtime ignores messages without
      // a room, so restaurant's queue is unaffected by these events.
      const channel = manager.getChannel();
      if (!channel) {
        console.error(
          "order:available notify skipped — RabbitMQ not connected",
        );
        return;
      }
      for (const rider of riders) {
        try {
          channel.sendToQueue(
            process.env.REALTIME_QUEUE || "realtime.emit",
            Buffer.from(
              JSON.stringify({
                event: "order:available",
                room: `user:${rider.userId}`,
                payload: { orderId, restaurantId },
              }),
            ),
            { persistent: true },
          );
        } catch (error: any) {
          console.error("Error notifying rider:", rider.userId, error?.message);
        }
      }
    },
  });
