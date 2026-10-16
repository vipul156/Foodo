import { makeDomainEventPublisher, sendWorkItem } from "@foodo/backend-common/aws";

// ─── Event wiring (rider-service, AWS) ───────────────────────
// Replaces config/rabbitmq.ts + event.publisher.ts:
//
//   fanout exchange  → SNS topic (EVENTS_TOPIC_ARN)
//   ORDER_QUEUE      → SQS ORDER_QUEUE_URL (this service consumes it)
//
// publishRiderEvent keeps the exact contract the accept hot path relies
// on: resolve FALSE on publish failure so the caller rolls the rider
// claim back (a dropped event would strand the rider offline forever —
// no compensation exists if the event never reaches the broker).

export const publishRiderEvent = makeDomainEventPublisher();

const orderQueueUrl = () => process.env.ORDER_QUEUE_URL ?? "";

/** Work-queue publish (kept for the few direct-queue callers). */
export const publishEvent = async (type: string, data: unknown) => {
  await sendWorkItem(orderQueueUrl(), type, data);
};
