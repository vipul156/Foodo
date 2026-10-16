import {
  type DynamoOrder,
  assignRider,
  transitionRiderStatus,
  stampPaymentIntent,
  markOrderPaid,
  getRestaurantById,
} from "@foodo/backend-common/dynamo";
import { handleSqsBatch } from "@foodo/backend-common/aws";
import { clearCart } from "../dynamo/cart.js";
import { publishRealtimeEvent, publishOrderEvent } from "./events.js";

// ─── SQS consumers (Lambda event sources) ────────────────────
// Replaces config/payment.consumer.ts + config/riderEvent.consumer.ts.
// Queue attach / ack policy / retry / DLQ / reconnect re-attachment all
// disappear: Lambda is invoked per message batch, SQS redrive policy
// owns retries, and the DLQ is declared on the queue (IaC, later).
//
//   PAYMENT_QUEUE_URL  — payment.success work items ({ type, data })
//   RIDER_EVENTS_QUEUE_URL — SNS subscriptions filtered on `event`
//
// Handlers must stay idempotent (SQS is at-least-once):
//   - markOrderPaid: conditional on paymentStatus <> paid
//   - stampPaymentIntent: conditional on paymentStatus <> paid
//   - transitions: exact from-status guards
//   - assignRider: conditional on riderId = null AND ready_for_rider

// ─── Payment success (was payment.consumer.ts) ───────────────
const onPaymentSuccess = async (data: { orderId: string }) => {
  if (!data?.orderId) return;

  const order = await markOrderPaid(data.orderId);
  if (!order) return; // already paid (redelivery) or swept — no-op

  // Payment confirmed — clear the cart BEFORE notifying anyone so any
  // cart refetch triggered by the sockets below sees the empty cart.
  await clearCart(order.userId);

  await publishRealtimeEvent("order:new", `restaurant:${order.restaurantId}`, {
    orderId: order.id,
  });
  // Seller sockets join user:{id} rooms — dual-emit to the owner.
  const restaurant = await getRestaurantById(order.restaurantId);
  if (restaurant) {
    await publishRealtimeEvent("order:new", `user:${restaurant.ownerId}`, {
      orderId: order.id,
    });
  }
  await publishRealtimeEvent("order:update", `user:${order.userId}`, {
    orderId: order.id,
    status: "placed",
  });
};

export const paymentQueueHandler = async (event: any) =>
  handleSqsBatch(event, async (data: { orderId: string }) =>
    onPaymentSuccess(data),
  );

// ─── Rider/domain events (was riderEvent.consumer.ts) ────────
// SNS → SQS subscription: the fanout envelope { event, room, payload }
// arrives inside the SNS notification wrapper.

const unwrapSnsEnvelope = (record: any): {
  event: string;
  room?: string;
  payload: any;
} | null => {
  try {
    const body = JSON.parse(record.body);
    const inner = body.TopicArn ? JSON.parse(body.Message) : body;
    return inner;
  } catch {
    return null;
  }
};

export const riderEventsHandler = async (event: any) =>
  handleSqsBatch(event, async (_data, raw) => {
    const envelope = unwrapSnsEnvelope(raw);
    if (!envelope?.event) return;

    const { event, payload } = envelope;

    if (event === "rider.order_accepted") {
      await onRiderOrderAccepted(payload);
    } else if (event === "rider.order_status_changed") {
      await onRiderStatusChanged(payload);
    } else if (event === "payment.intent.created") {
      await onPaymentIntentCreated(payload);
    }
    // Unknown events: acked and dropped (not ours) — same policy as the
    // shared fanout consumer had.
  });

const onRiderOrderAccepted = async (payload: {
  orderId: string;
  riderId: string;
  riderUserId?: string;
  riderName?: string;
  riderPhone?: number | string;
  riderPicture?: string | null;
}) => {
  if (!payload?.orderId || !payload?.riderId) return;

  const order = await assignRider(payload.orderId, payload);
  if (!order) {
    // Order gone/taken/expired — ask the rider service to free the
    // rider (its consumer is the saga compensation).
    await publishOrderEvent("rider.order_rejected", {
      riderId: payload.riderId,
      riderUserId: payload.riderUserId,
      orderId: payload.orderId,
    });
    console.log(
      `[COMPENSATE] order ${payload.orderId} not assignable — rider ${payload.riderId} release requested`,
    );
    return;
  }

  await emitAssignedRealtime(order, payload.riderUserId);
};

const onRiderStatusChanged = async (payload: {
  orderId: string;
  riderId: string;
}) => {
  if (!payload?.orderId || !payload?.riderId) return;

  const order = await transitionRiderStatus(payload.orderId, payload.riderId);
  if (!order) return; // stale event / redelivery — idempotent no-op

  if (order.status === "picked_up") {
    await emitStatusRealtime(order);
  } else if (order.status === "delivered") {
    await emitDeliveredRealtime(order);
    // Choreography continuation: rider-service frees the rider.
    await publishOrderEvent("order.delivered", {
      orderId: order.id,
      riderId: payload.riderId,
    });
  }
};

const onPaymentIntentCreated = async (payload: {
  orderId: string;
  provider: "razorpay" | "stripe";
  providerOrderId: string;
}) => {
  if (
    !payload?.orderId ||
    !payload?.provider ||
    !payload?.providerOrderId ||
    (payload.provider !== "razorpay" && payload.provider !== "stripe")
  ) {
    return;
  }

  const stamped = await stampPaymentIntent(
    payload.orderId,
    payload.provider,
    payload.providerOrderId,
  );

  if (!stamped) {
    // Order already paid (webhook won the race) or TTL-swept — the
    // provider intent is an orphan; reconciliation flags those.
    console.error(
      `[ALERT][RECONCILE] payment.intent.created for ${payload.orderId}: order not stampable (paid/cancelled/expired)`,
    );
  }
};

// ─── Realtime emission helpers ───────────────────────────────

async function emitAssignedRealtime(
  order: DynamoOrder,
  riderUserId?: string,
) {
  await Promise.all([
    publishRealtimeEvent("order:rider_assigned", `restaurant:${order.restaurantId}`, { order }),
    publishRealtimeEvent("order:rider_assigned", `user:${order.userId}`, { order }),
  ]);
  const restaurant = await getRestaurantById(order.restaurantId);
  if (restaurant) {
    await publishRealtimeEvent("order:rider_assigned", `user:${restaurant.ownerId}`, { order });
  }
  if (riderUserId) {
    await publishRealtimeEvent("order:rider_assigned", `user:${riderUserId}`, { order });
  }
}

async function emitStatusRealtime(order: DynamoOrder) {
  await Promise.all([
    publishRealtimeEvent("order:update", `user:${order.userId}`, {
      orderId: order.id,
      status: order.status,
    }),
    publishRealtimeEvent("order:update", `restaurant:${order.restaurantId}`, {
      orderId: order.id,
      status: order.status,
    }),
  ]);
  const restaurant = await getRestaurantById(order.restaurantId);
  if (restaurant) {
    await publishRealtimeEvent("order:update", `user:${restaurant.ownerId}`, {
      orderId: order.id,
      status: order.status,
    });
  }
}

async function emitDeliveredRealtime(order: DynamoOrder) {
  await emitStatusRealtime(order);
  await publishRealtimeEvent("order:delivered", `user:${order.userId}`, order);
}
