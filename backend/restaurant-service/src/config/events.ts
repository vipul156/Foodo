import {
  makeFanoutPublisher,
  makeDomainEventPublisher,
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
//   publishOrderEvent(event, payload)           — bounded SNS (bool)
//   publishEvent(type, data)                    — SQS work item (throws)

export const publishRealtimeEvent = makeFanoutPublisher();

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
