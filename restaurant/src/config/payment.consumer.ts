import { getChannel } from "./rabbitmq.js";
import { Order } from "../models/Order.js";
import axios from "axios";

export const startPaymentConsumer = async () => {
  const channel = getChannel();

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

      await axios.post(
        `${process.env.REALTIME_SERVICE_URL}/api/v1/internal/emit`,
        {
          event: "order:new",
          room: `restaurant:${order.restaurantId}`,
          payload: {
            orderId: order._id,
          },
        },
        {
          headers: {
            "x-internal-key": process.env.INTERNAL_SERVICE_KEY,
          },
        },
      );

      channel.ack(msg);
    } catch (error) {
      console.error("Error parsing payment event:", error);
    }
  });
};
