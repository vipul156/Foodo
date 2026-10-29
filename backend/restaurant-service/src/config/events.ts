import {
  makeFanoutPublisher,
  makeDomainEventPublisher,
  publishFanoutBatch,
  sendWorkItem,
} from "@foodo/backend-common/aws";

// ─── Event wiring (restaurant-service, AWS) ──────────────────
// Replaces config/rabbitmq.ts + order.publisher.ts + realtime.publisher.ts:
//
//   fanout exchange        → SNS topic (EVENTS_TOPIC_ARN)
//   ORDER_QUEUE (work)     → SQS ORDER_QUEUE_URL (rider-service consumes)
//   PAYMENT_QUEUE (work)   → SQS PAYMENT_QUEUE_URL (this service consumes)
//
// Publishers stay the same three shapes the controllers already call:
//   publishRealtimeEvent(event, room, payload)  — fire-and-forget SNS
//   publishRealtimeBatch([{ event, room, payload }]) — same, 10 per request
//   publishOrderEvent(event, payload)           — bounded SNS (bool)
//   publishEvent(type, data)                    — SQS work item (throws)

export const publishRealtimeEvent = makeFanoutPublisher();

/**
 * Batched form of `publishRealtimeEvent`: SNS takes 10 messages per
 * request, so one action that targets several rooms (customer, the
 * restaurant room, the owner's user room) costs one request, not three.
 */
export const publishRealtimeBatch = publishFanoutBatch;

export const publishOrderEvent = makeDomainEventPublisher();

const orderQueueUrl = () => process.env.ORDER_QUEUE_URL ?? "";

/**
 * Work-queue publish to the rider matcher ({ type, data } envelope —
 * the SQS consumer reads the same shape). Throws on failure so the
 * HTTP layer surfaces a 5xx the client can retry (same contract as the
 * old getChannelAsync().sendToQueue path).
 */
export const publishEvent = async (type: string, data: unknown) => {
  await sendWorkItem(orderQueueUrl(), type, data);
};
