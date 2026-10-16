import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

// ─── Event bus: SNS fanout + SQS work queues ─────────────────
// Replaces the shared RabbitMQ layer (@foodo/backend-common/queue):
//
//   RabbitMQ fanout exchange  →  SNS topic  (foodo-events)
//     realtime broadcasts { event, room, payload } and domain events
//     { event, payload } both publish here; every service owns an SQS
//     queue subscribed to the topic with a FilterPolicy on `event`.
//
//   RabbitMQ work queue       →  SQS queue  (foodo-payment, foodo-order)
//     the { type, data } envelope rides as a MessageAttribute `type`
//     (also kept in the body for payload-only consumers).
//
// Resilience mapping:
//   - RabbitMQ persistent messages  → SNS/SQS are durable by default
//   - retry-with-TTL parking lot    → SQS redrive policy (maxReceiveCount)
//   - .dlq poison-pill queue        → dedicated DLQ per queue
//   - bounded-wait getChannelAsync  → SDK retry policy (built into clients)
//   - fire-and-forget drop+log      → same: publish errors are logged and
//     swallowed for realtime-tier events, thrown for domain-critical ones.

// Warm-container reuse: one client per Lambda execution environment,
// created lazily on first publish (same pattern as docClient).
let snsClient: SNSClient | undefined;
let sqsClient: SQSClient | undefined;

const getSns = () => (snsClient ??= new SNSClient({ maxAttempts: 3 }));
const getSqs = () => (sqsClient ??= new SQSClient({ maxAttempts: 3 }));

const topicArn = () => process.env.EVENTS_TOPIC_ARN ?? "";

// ─── Fanout publisher (realtime-tier style) ──────────────────
/**
 * Fire-and-forget publish onto the SNS event topic. Drops the event
 * with a log when SNS fails — never blocks or fails the request.
 * Best for realtime broadcasts, where a lost event costs one stale UI.
 */
export function makeFanoutPublisher() {
  return async (event: string, room: string, payload: unknown): Promise<void> => {
    try {
      await getSns().send(
        new PublishCommand({
          TopicArn: topicArn(),
          Message: JSON.stringify({ event, room, payload }),
          MessageAttributes: {
            event: { DataType: "String", StringValue: event },
          },
        }),
      );
    } catch (error) {
      console.error(
        `Realtime publish failed (${event}):`,
        error instanceof Error ? error.message : error,
      );
    }
  };
}

// ─── Domain-event publisher (bounded, must-know style) ───────
/**
 * Publish onto the SNS event topic and surface failure to the caller:
 * resolves false on error so domain flows can compensate (reject the
 * request, roll back a claim, or 5xx for provider redelivery) instead
 * of silently dropping a money- or rider-affecting event.
 */
export function makeDomainEventPublisher() {
  return async (
    event: string,
    payload: unknown,
    _timeoutMs = 5000,
  ): Promise<boolean> => {
    try {
      await getSns().send(
        new PublishCommand({
          TopicArn: topicArn(),
          Message: JSON.stringify({ event, room: undefined, payload }),
          MessageAttributes: {
            event: { DataType: "String", StringValue: event },
          },
        }),
      );
      return true;
    } catch (error) {
      console.error(
        `Event publish failed (${event}):`,
        error instanceof Error ? error.message : error,
      );
      return false;
    }
  };
}

// ─── Work-queue publisher (SQS) ──────────────────────────────
/**
 * Send a { type, data } work item to an SQS queue. `type` rides as a
 * MessageAttribute so consumers can filter without deserializing, and
 * in the body so handlers see the exact envelope the RabbitMQ consumers
 * used. Throws on failure — the HTTP layer surfaces a 5xx the client
 * (or webhook provider) can retry.
 */
export async function sendWorkItem(
  queueUrl: string,
  type: string,
  data: unknown,
): Promise<void> {
  await getSqs().send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({ type, data }),
      MessageAttributes: {
        type: { DataType: "String", StringValue: type },
      },
    }),
  );
}

// ─── Lambda SQS consumer skeleton ────────────────────────────
export interface SqsHandlerResult {
  /** Record indices that must be retried (reappear in the next poll). */
  failures: number[];
}

/**
 * Batch-aware SQS Lambda handler shape: reports partial failures via
 * batchItemFailures so only failed records redrive (DLQ via redrive
 * policy after maxReceiveCount). Handlers must stay idempotent — SQS
 * is at-least-once, exactly like the old RabbitMQ consumers.
 */
export async function handleSqsBatch<T = any>(
  event: { Records: Array<{ body: string; messageAttributes?: any; messageId?: string }> },
  onMessage: (data: T, raw: { body: string }) => Promise<void>,
): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> {
  const failures: string[] = [];

  await Promise.all(
    (event.Records ?? []).map(async (record, index) => {
      try {
        const parsed = JSON.parse(record.body);
        // { type, data } work-queue envelope; plain payloads pass through
        const data = parsed && typeof parsed === "object" && "data" in parsed
          ? parsed.data
          : parsed;
        await onMessage(data as T, record);
      } catch (error) {
        console.error(
          `[SQS] message ${record.messageId ?? index} failed:`,
          error instanceof Error ? error.message : error,
        );
        failures.push(String(record.messageId ?? index));
      }
    }),
  );

  return { batchItemFailures: failures.map((id) => ({ itemIdentifier: id })) };
}
