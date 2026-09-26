import { startQueueConsumer } from "@foodo/backend-common/queue";
import { manager } from "./rabbitmq.js";
import { publishRealtimeEvent } from "./realtime.publisher.js";
import { Order, Restaurant } from "@foodo/backend-common/models";
import { Cart } from "../models/Cart.js";

// ─── Payment success consumer ────────────────────────────────
// Queue attach, { type, data } envelope parsing, ack policy, retry+DLQ
// and reconnect re-attachment live in the shared startQueueConsumer
// builder — this file only provides the business logic.
//
// The gateway (utils-service) publishes PAYMENT_SUCCESS on this queue
// after signature-verified webhook processing. The update is idempotent
// (paymentStatus: { $ne: "paid" }) so provider/webhook redeliveries and
// retries never double-apply.
const onPaymentSuccess = async (data: { orderId: string }) => {
  const { orderId } = data;

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
};

export const startPaymentConsumer = () =>
  startQueueConsumer(manager, {
    queueEnvVar: "PAYMENT_QUEUE",
    defaultQueue: "payment.events",
    onMessage: onPaymentSuccess,
  });
