import type { Channel, ConsumeMessage } from "amqplib";
import { onChannelReady } from "./rabbitmq.js";
import {
  declareResilienceQueues,
  handleConsumeFailure,
} from "@foodo/backend-common/queue";
import { publishRealtimeEvent } from "./realtime.publisher.js";
import { publishOrderEvent } from "./order.publisher.js";
import { Order, Restaurant } from "@foodo/backend-common/models";
import { assignRiderToOrder } from "../controllers/order.js";

// ─── Rider event consumer (assignment + lifecycle) ──────────
// Rider acceptance is async: the rider claims itself and returns 200
// instantly; THIS consumer performs the atomic order assignment in the
// background and pushes the socket updates over the fanout exchange.
// If the assignment is impossible, it publishes rider.order_rejected —
// the rider service's consumer compensates by freeing the rider.
//
// Also consumes the lifecycle events that replaced the last internal
// HTTP write endpoints:
//   - payment.intent.created → stamps the provider order id (was
//     PUT /api/order/payment/attached/:id)
//   - rider.order_status_changed → picked_up / delivered transitions
//     driven by the rider (was PUT /api/order/update/status/rider)
// (order.cancelled is consumed by the RIDER service — it owns rider
// state; restaurant only publishes it.)
const onRiderEvent =
  (channel: Channel, queue: string) =>
  async (msg: ConsumeMessage | null): Promise<void> => {
    if (!msg) return;

    try {
      const { event, payload } = JSON.parse(msg.content.toString());

      if (
        event === "rider.order_accepted" &&
        payload?.orderId &&
        payload?.riderId
      ) {
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
        channel.ack(msg);
        return;
      }

      // ─── rider.order_status_changed → lifecycle transition ────
      // Idempotent + one-way: picked_up must come from rider_assigned,
      // delivered from picked_up. Redeliveries and stale events match
      // neither guard and ack as no-ops. A stale event for an order
      // assigned to a DIFFERENT rider is dropped by the riderId check.
      if (
        event === "rider.order_status_changed" &&
        payload?.orderId &&
        payload?.riderId
      ) {
        const order = await Order.findOne({
          _id: payload.orderId,
          riderId: payload.riderId,
        });

        if (!order) {
          // Gone, or rider no longer matches → stale event, drop.
          channel.ack(msg);
          return;
        }

        if (order.status === "rider_assigned") {
          order.status = "picked_up";
          await order.save();
          await emitStatusRealtime(order);
        } else if (order.status === "picked_up") {
          order.status = "delivered";
          await order.save();
          await emitDeliveredRealtime(order);

          // Choreography continuation: tell the rider service the delivery
          // landed so ITS consumer frees the rider (rider state is owned
          // by rider-service — restaurant never writes it directly).
          await publishOrderEvent("order.delivered", {
            orderId: order._id,
            riderId: payload.riderId,
          });
        }
        // Anything else (delivered/cancelled/placed...) → no-op ack:
        // either a redelivery of an applied transition or a stale event.

        channel.ack(msg);
        return;
      }

      // ─── payment.intent.created → stamp the provider order id ────
      // utils fired this right after creating the provider intent (was
      // PUT /api/order/payment/attached/:id). Idempotent: $set of the
      // same values, so redeliveries are no-ops. Guarded to unpaid
      // orders so a late event can never touch a paid/cancelled one.
      if (
        event === "payment.intent.created" &&
        payload?.orderId &&
        payload?.provider &&
        payload?.providerOrderId &&
        (payload.provider === "razorpay" || payload.provider === "stripe")
      ) {
        const stamped = await Order.findOneAndUpdate(
          { _id: payload.orderId, paymentStatus: { $ne: "paid" } },
          {
            $set: {
              "paymentIntent.provider": payload.provider,
              "paymentIntent.providerOrderId": payload.providerOrderId,
              "paymentIntent.initiatedAt": new Date(),
            },
          },
          { new: true },
        ).select("_id paymentIntent");

        if (!stamped) {
          // Order already paid (webhook won the race) or TTL-expired —
          // the provider intent is now an orphan; the reconciliation
          // job flags those for manual cleanup.
          console.error(
            `[ALERT][RECONCILE] payment.intent.created for ${payload.orderId}: order not stampable (paid/cancelled/expired)`,
          );
        }
        channel.ack(msg);
        return;
      }

      // Unknown event on the shared fanout — not ours, drop quietly.
      channel.ack(msg);
    } catch (error) {
      // DB blips retry with backoff, then DLQ + alert
      handleConsumeFailure(channel, msg, queue, error);
      return;
    }
  };

// ─── Realtime emission helpers (moved verbatim from the HTTP handlers) ──
async function emitStatusRealtime(order: any) {
  // Customer sees "picked up"; seller sees the board move to In Delivery
  publishRealtimeEvent("order:update", `user:${order.userId}`, {
    orderId: order._id,
    status: order.status,
  });
  publishRealtimeEvent("order:update", `restaurant:${order.restaurantId}`, {
    orderId: order._id,
    status: order.status,
  });
  const restaurant = await Restaurant.findById(order.restaurantId);
  if (restaurant) {
    publishRealtimeEvent("order:update", `user:${restaurant.ownerId}`, {
      orderId: order._id,
      status: order.status,
    });
  }
}

async function emitDeliveredRealtime(order: any) {
  publishRealtimeEvent("order:delivered", `user:${order.userId}`, order);
  publishRealtimeEvent("order:update", `user:${order.userId}`, {
    orderId: order._id,
    status: order.status,
  });
  publishRealtimeEvent("order:update", `restaurant:${order.restaurantId}`, {
    orderId: order._id,
    status: order.status,
  });
  const restaurant = await Restaurant.findById(order.restaurantId);
  if (restaurant) {
    publishRealtimeEvent("order:update", `user:${restaurant.ownerId}`, {
      orderId: order._id,
      status: order.status,
    });
  }
}

export const startRiderEventConsumer = () => {
  // Registered once; re-runs on EVERY fresh channel — consume
  // registrations die with the channel, so after a RabbitMQ restart the
  // consumer re-attaches automatically.
  onChannelReady(async (channel) => {
    const exchange = process.env.REALTIME_EXCHANGE || "order.status_changed";
    const queue = process.env.RIDER_EVENTS_QUEUE || "restaurant.rider_events";

    await channel.assertExchange(exchange, "fanout", { durable: true });
    await channel.assertQueue(queue, { durable: true });
    await channel.bindQueue(queue, exchange, "");
    await declareResilienceQueues(channel, queue);

    channel.consume(queue, onRiderEvent(channel, queue));

    console.log(
      `Restaurant consuming rider events from exchange "${exchange}"`,
    );
  });
};
