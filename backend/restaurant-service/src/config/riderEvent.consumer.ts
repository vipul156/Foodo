import { startFanoutConsumer } from "@foodo/backend-common/queue";
import { manager } from "./rabbitmq.js";
import { publishRealtimeEvent } from "./realtime.publisher.js";
import { publishOrderEvent } from "./order.publisher.js";
import { Order, Restaurant } from "@foodo/backend-common/models";
import { assignRiderToOrder } from "../controllers/order.js";

// ─── Rider event consumer (assignment + lifecycle) ──────────
// Handler dispatch, topology, ack policy, retry+DLQ and reconnect
// re-attachment all live in the shared startFanoutConsumer builder —
// this file only provides the business logic per event.
//
//   rider.order_accepted → atomic order assignment (saga start); on
//     failure publishes rider.order_rejected (rider service compensates)
//   rider.order_status_changed → picked_up / delivered transitions
//     driven by the rider (was PUT /api/order/update/status/rider)
//   payment.intent.created → stamps the provider order id (was
//     PUT /api/order/payment/attached/:id)
// (order.cancelled is consumed by the RIDER service — it owns rider
// state; restaurant only publishes it.)
export const startRiderEventConsumer = () =>
  startFanoutConsumer(manager, {
    queueEnvVar: "RIDER_EVENTS_QUEUE",
    defaultQueue: "restaurant.rider_events",
    handlers: {
      "rider.order_accepted": async ({ payload }) => {
        if (!payload?.orderId || !payload?.riderId) return;

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
      },

      "rider.order_status_changed": async ({ payload }) => {
        if (!payload?.orderId || !payload?.riderId) return;

        const order = await Order.findOne({
          _id: payload.orderId,
          riderId: payload.riderId,
        });

        if (!order) {
          // Gone, or rider no longer matches → stale event, drop.
          return;
        }

        // Idempotent + one-way: picked_up must come from rider_assigned,
        // delivered from picked_up. Redeliveries and stale events match
        // neither guard and ack as no-ops.
        if (order.status === "rider_assigned") {
          order.status = "picked_up";
          await order.save();
          await emitStatusRealtime(order);
        } else if (order.status === "picked_up") {
          order.status = "delivered";
          await order.save();
          await emitDeliveredRealtime(order);

          // Choreography continuation: tell the rider service the
          // delivery landed so ITS consumer frees the rider (rider state
          // is owned by rider-service — restaurant never writes it).
          await publishOrderEvent("order.delivered", {
            orderId: order._id,
            riderId: payload.riderId,
          });
        }
      },

      "payment.intent.created": async ({ payload }) => {
        if (
          !payload?.orderId ||
          !payload?.provider ||
          !payload?.providerOrderId ||
          (payload.provider !== "razorpay" && payload.provider !== "stripe")
        ) {
          return;
        }

        // Idempotent: $set of the same values, so redeliveries are
        // no-ops. Guarded to unpaid orders so a late event can never
        // touch a paid/cancelled one.
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
      },
    },
  });

// ─── Realtime emission helpers (order lifecycle broadcasts) ──
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
