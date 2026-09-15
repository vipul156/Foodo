import { getChannel } from "./rabbitmq.js";
import { Order } from "../models/Order.js";
import { Restaurant } from "../models/Restaurant.js";
import axios from "axios";

export const startPaymentConsumer = async () => {
  const channel = getChannel();
  if (!channel) {
    console.error("RabbitMQ channel not available, payment consumer not started");
    return;
  }

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

      const emit = (event: string, room: string, payload: unknown) =>
        axios.post(
          `${process.env.REALTIME_SERVICE_URL}/api/internal/emit`,
          { event, room, payload },
          {
            headers: {
              "x-internal-key": process.env.INTERNAL_SERVICE_KEY,
            },
          },
        );

      // Notify the restaurant board
      await emit("order:new", `restaurant:${order.restaurantId}`, {
        orderId: order._id,
      });

      // Seller sockets only join user:{id} rooms (auth JWT has no
      // restaurantId) — dual-emit to the owner so the board updates live.
      const restaurant = await Restaurant.findById(order.restaurantId);
      if (restaurant) {
        await emit("order:new", `user:${restaurant.ownerId}`, {
          orderId: order._id,
        });
      }

      // Customer's "My Orders" fills in the moment payment succeeds
      await emit("order:update", `user:${order.userId}`, {
        orderId: order._id,
        status: "placed",
      });

      channel.ack(msg);
    } catch (error) {
      console.error("Error parsing payment event:", error);
    }
  });
};
