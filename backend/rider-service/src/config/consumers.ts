import { handleSqsBatch } from "@foodo/backend-common/aws";
import {
  listAvailableRidersNear,
  releaseRiderFromOrder,
  type DynamoRider,
} from "@foodo/backend-common/dynamo";
import { makeFanoutPublisher, publishFanoutBatch } from "@foodo/backend-common/aws";

// ─── SQS consumers (rider-service, Lambda event sources) ─────
// Replaces config/orderReady.consumer.ts + config/riderEvent.consumer.ts.
//
//   orderQueue  — order:ready_for_rider matcher work items (SQS)
//   riderEvents — SNS-filtered compensation events, pushed straight to
//     the function (no queue): rider.order_rejected /
//     order.cancelled / order.delivered
//
// The saga semantics are unchanged: every release is a CONDITIONAL
// update keyed to the order the rider is claimed by.

const publishRealtimeEvent = makeFanoutPublisher();

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

// ─── Order-ready matcher (was orderReady.consumer.ts) ────────
// `handleSqsBatch` already unwraps the { type, data } work envelope, so
// the callback receives the ready-order payload itself — not the
// envelope. (It used to look for `data.type` on the already-unwrapped
// payload, which never matched and acked every message as "not ours".)
export const orderReadyHandler = async (event: any) =>
  handleSqsBatch(event, async (data: any) => {
    const { orderId, restaurantId, location } = data ?? {};
    if (!orderId || !restaurantId || !location) return;

    const [lon, lat] = location.coordinates ?? [];

    // Available riders within 10km of the restaurant (bounding box +
    // haversine inside the repository — the $near replacement).
    const riders = await listAvailableRidersNear(lat, lon, 10_000);

    console.log(
      `Found ${riders.length} available riders for order ${orderId}`,
    );

    if (riders.length === 0) {
      console.log("No riders available for order:", orderId);
      return;
    }

    // One broadcast per rider, but 10 per SNS request: a 25-rider pool
    // costs 3 PublishBatch calls instead of 25 Publish calls.
    await publishFanoutBatch(
      riders.map((rider: DynamoRider) => ({
        event: "order:available",
        room: `user:${rider.userId}`,
        payload: { orderId, restaurantId },
      })),
    );
  });

// ─── Compensation events (was riderEvent.consumer.ts) ────────
export const riderEventsHandler = async (event: any) =>
  handleSqsBatch(event, async (_data, raw) => {
    const envelope = unwrapSnsEnvelope(raw);
    if (!envelope?.event) return;

    const { event: eventName, payload } = envelope;

    if (eventName === "rider.order_rejected") {
      if (!payload?.riderId) return;
      await releaseRiderFromOrder(
        payload.riderId,
        payload.orderId,
        { orderId: null, status: "cancelled" },
        publishRealtimeEvent,
      );
    } else if (eventName === "order.cancelled") {
      if (!payload?.riderId) return;
      await releaseRiderFromOrder(
        payload.riderId,
        payload.orderId,
        { orderId: null, status: "cancelled" },
        publishRealtimeEvent,
      );
    } else if (eventName === "order.delivered") {
      if (!payload?.riderId) return;
      await releaseRiderFromOrder(
        payload.riderId,
        payload.orderId,
        { orderId: payload.orderId, status: "delivered" },
        publishRealtimeEvent,
      );
    }
    // Unknown events: acked and dropped (not ours).
  });
