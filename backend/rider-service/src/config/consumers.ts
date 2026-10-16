import { handleSqsBatch } from "@foodo/backend-common/aws";
import {
  listAvailableRidersNear,
  releaseRiderFromOrder,
  type DynamoRider,
} from "@foodo/backend-common/dynamo";
import { makeFanoutPublisher } from "@foodo/backend-common/aws";

// ─── SQS consumers (rider-service, Lambda event sources) ─────
// Replaces config/orderReady.consumer.ts + config/riderEvent.consumer.ts.
//
//   ORDER_QUEUE_URL        — order:ready_for_rider matcher work items
//   RIDER_EVENTS_QUEUE_URL — SNS-filtered compensation events
//     (rider.order_rejected / order.cancelled / order.delivered)
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
export const orderReadyHandler = async (event: any) =>
  handleSqsBatch(event, async (data: any) => {
    if (data?.type !== "order:ready_for_rider") {
      return;
    }

    const { orderId, restaurantId, location } = data.data;
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

    // One realtime broadcast per rider — SNS fanout, fire-and-forget.
    await Promise.all(
      riders.map((rider: DynamoRider) =>
        publishRealtimeEvent(
          "order:available",
          `user:${rider.userId}`,
          { orderId, restaurantId },
        ),
      ),
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
