import type { Channel, ConsumeMessage } from "amqplib";
import { onChannelReady } from "./rabbitmq.js";
import {
  declareResilienceQueues,
  handleConsumeFailure,
} from "./queue.resilience.js";
import { Rider } from "../model/Rider.js";
import http from "./http.js";

const onOrderReady =
  (channel: Channel) =>
  async (msg: ConsumeMessage | null): Promise<void> => {
    if (!msg) return;

    try {
      const event = JSON.parse(msg.content.toString());

      if (event.type !== "order:ready_for_rider") {
        channel.ack(msg);
        return;
      }

      const { orderId, restaurantId, location } = event.data;

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
        channel.ack(msg);
        return;
      }

      for (const rider of riders) {
        try {
          await http.post(
            `${process.env.REALTIME_SERVICE_URL}/api/internal/emit`,
            {
              event: "order:available",
              room: `user:${rider.userId}`,
              payload: { orderId, restaurantId },
            },
            {
              headers: {
                "x-internal-key": process.env.INTERNAL_SERVICE_KEY,
              },
            },
          );
        } catch (error: any) {
          console.error("Error notifying rider:", rider.userId, error?.message);
        }
      }
      channel.ack(msg);
    } catch (error) {
      // Never ack a failure: retry with backoff, then DLQ + alert.
      // Previously the message was acked here, confirming deletion of
      // an event that never got processed.
      handleConsumeFailure(channel, msg, process.env.ORDER_QUEUE!, error);
    }
  };

export const startOrderReadyConsumer = () => {
  // Registered once; re-runs on EVERY fresh channel — consume
  // registrations die with the channel, so after a RabbitMQ restart the
  // consumer re-attaches automatically.
  onChannelReady(async (channel) => {
    // Retry parking lot + DLQ for this queue
    await declareResilienceQueues(channel, process.env.ORDER_QUEUE!);

    channel.consume(process.env.ORDER_QUEUE!, onOrderReady(channel));
    console.log("Order ready consumer attached");
  });
};
