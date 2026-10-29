import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import type { SNSEvent, SQSEvent } from "aws-lambda";

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

// ─── Lambda consumer skeleton ────────────────────────────────
/**
 * The record shape every consumer handler reads. Identical to an SQS
 * record for the fields handlers use, so a function can be triggered
 * by an SQS event source OR by a direct SNS subscription without a
 * second code path (see `toSqsShape`).
 */
export interface SqsBatchEvent {
  Records: Array<{ body: string; messageAttributes?: any; messageId?: string }>;
}

export interface SqsBatchResult {
  /** Records that must be retried (SQS) — SNS ignores this (see handlePushBatch). */
  batchItemFailures: Array<{ itemIdentifier: string }>;
}

/**
 * Batch-aware SQS Lambda handler shape: reports partial failures via
 * batchItemFailures so only failed records redrive (DLQ via redrive
 * policy after maxReceiveCount). Handlers must stay idempotent — SQS
 * is at-least-once, exactly like the old RabbitMQ consumers.
 */
export async function handleSqsBatch<T = any>(
  event: SqsBatchEvent,
  onMessage: (data: T, raw: { body: string }) => Promise<void>,
): Promise<SqsBatchResult> {
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

// ─── Push trigger (SNS → Lambda) ─────────────────────────────
/**
 * Normalise an SNS notification batch into the SQS record shape.
 *
 * A direct SNS subscription delivers `{ Records: [{ Sns }] }`. Raw
 * message delivery is impossible for Lambda endpoints, so the inner
 * `Sns.Message` is unwrapped here — handlers then see exactly the bytes
 * a raw-delivery SQS subscription used to carry. SQS events pass
 * through untouched, which keeps one handler usable on both triggers.
 */
export function toSqsShape(event: SNSEvent | SQSEvent): SqsBatchEvent {
  const records = (event as SNSEvent)?.Records ?? [];
  if (!(records[0] as any)?.Sns) return event as SqsBatchEvent;

  return {
    Records: records.map((record) => ({
      messageId: record.Sns.MessageId,
      body: record.Sns.Message,
      messageAttributes: Object.fromEntries(
        Object.entries(record.Sns.MessageAttributes ?? {}).map(
          ([name, value]): [string, { stringValue: string }] => [
            name,
            { stringValue: value.Value ?? "" },
          ],
        ),
      ),
    })),
  };
}

/**
 * Entrypoint for a function subscribed DIRECTLY to the event topic.
 *
 * SNS ignores `batchItemFailures` — it retries on a thrown error — so a
 * partial failure reported by `handleSqsBatch` has to be rethrown here.
 * Without the throw the failed record would be acked and lost; with it,
 * SNS retries the delivery and the subscription's `redrivePolicy` parks
 * the poison message in the queue's DLQ.
 */
export async function handlePushBatch(
  event: SNSEvent | SQSEvent,
  onBatch: (batch: SqsBatchEvent) => Promise<SqsBatchResult | void>,
): Promise<SqsBatchResult | void> {
  const fromSns = Boolean((event as SNSEvent)?.Records?.[0]?.Sns);
  const result = await onBatch(toSqsShape(event));

  if (fromSns && result?.batchItemFailures?.length) {
    throw new Error(
      `Push delivery failed for ${result.batchItemFailures.length} event(s): ` +
        result.batchItemFailures.map((failure) => failure.itemIdentifier).join(", "),
    );
  }

  return result;
}
