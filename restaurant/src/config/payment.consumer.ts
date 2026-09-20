import { getChannel } from "./rabbitmq.js";
import {
  declareResilienceQueues,
  handleConsumeFailure,
} from "./queue.resilience.js";
import { publishRealtimeEvent } from "./realtime.publisher.js";
import { Order } from "../models/Order.js";
import { Restaurant } from "../models/Restaurant.js";
import { Cart } from "../models/Cart.js";

export const startPaymentConsumer = async () => {
  const channel = getChannel();
  if (!channel) {
    console.error("RabbitMQ channel not available, payment consumer not started");
    return;
  }

  // Retry parking lot + DLQ for this queue
  await declareResilienceQueues(channel, process.env.PAYMENT_QUEUE!);

  channel.consume(process.env.PAYMENT_QUEUE!, async (msg) => {
    if (!msg) {
      return;
    }

    try {
      const event = JSON.parse(msg.content.toString());

      const { orderId } = event.data;

      const order = await Order.findOneAndUpdate(
        { _id: orderId, paymentStatus: { $ne: "paid" } },
        {
          $set: {
            paymentStatus: "paid",
            status: "placed",
          },
          $unset: {
            expiresAt: 1,
          },
        },
        {
          new: true,
        },
      );

      if (!order) {
        channel.ack(msg);
        return;
      }

      console.log("Order updated:", order);

      // Payment is confirmed by the gateway — clear the cart BEFORE
      // notifying anyone. Any cart refetch triggered by the socket events
      // below must see the empty cart, not a stale one.
      // Abandoned checkouts keep their cart for the next attempt.
      await Cart.deleteMany({ userId: order.userId });

      // Realtime notifications go over the RabbitMQ fanout exchange —
      // fire-and-forget, never over HTTP to the socket tier.

      // Notify the restaurant board
      publishRealtimeEvent("order:new", `restaurant:${order.restaurantId}`, {
        orderId: order._id,
      });

      // Seller sockets only join user:{id} rooms (auth JWT has no
      // restaurantId) — dual-emit to the owner so the board updates live.
      const restaurant = await Restaurant.findById(order.restaurantId);
      if (restaurant) {
        publishRealtimeEvent("order:new", `user:${restaurant.ownerId}`, {
          orderId: order._id,
        });
      }

      // Customer's "My Orders" fills in the moment payment succeeds
      publishRealtimeEvent("order:update", `user:${order.userId}`, {
        orderId: order._id,
        status: "placed",
      });

      channel.ack(msg);
    } catch (error) {
      // Never swallow a failure: retry with backoff, then DLQ + alert.
      // Previously the error was only logged — the message sat unacked
      // forever and money taken left the order stuck in pending.
      handleConsumeFailure(channel, msg, process.env.PAYMENT_QUEUE!, error);
    }
  });
};
