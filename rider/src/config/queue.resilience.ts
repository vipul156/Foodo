import type { Channel, ConsumeMessage } from "amqplib";

// ─── Consumer resilience: retries with backoff + DLQ ────────
// A failed message must never be silently dropped or left stuck unacked.
// Failures are retried with exponential backoff (via a parking-lot queue
// with per-message TTL that dead-letters back to the main queue — delay
// without any RabbitMQ plugin), and after MAX_RETRIES the poison pill is
// routed to a Dead Letter Queue with an alert for manual inspection.

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000; // 2s → 4s → 8s

// Call once at consumer startup. NOTE: the main queue itself is NOT
// redeclared with DLX arguments (that would PRECONDITION_FAIL against the
// existing queue) — routing back is done explicitly in handleConsumeFailure.
export const declareResilienceQueues = async (
  channel: Channel,
  mainQueue: string,
) => {
  // Retry parking lot: expired per-message TTLs dead-letter back to the
  // main queue through the default exchange. (RabbitMQ evaluates TTLs
  // head-of-line — fine at this scale.)
  await channel.assertQueue(`${mainQueue}.retry`, {
    durable: true,
    arguments: {
      deadLetterExchange: "",
      deadLetterRoutingKey: mainQueue,
    },
  });

  // Poison pills land here for engineering inspection — never retried.
  await channel.assertQueue(`${mainQueue}.dlq`, { durable: true });
};

export const handleConsumeFailure = (
  channel: Channel,
  msg: ConsumeMessage,
  mainQueue: string,
  error: unknown,
) => {
  const headers: Record<string, unknown> = {
    ...(msg.properties.headers ?? {}),
  };
  const retries =
    typeof headers["x-retry-count"] === "number"
      ? headers["x-retry-count"]
      : 0;
  const errorMessage = String(
    (error as { message?: string } | null)?.message ?? error,
  ).slice(0, 500);

  if (retries < MAX_RETRIES) {
    const delay = RETRY_BASE_DELAY_MS * 2 ** retries;

    // Republish FIRST, ack SECOND — a crash in between duplicates the
    // message (at-least-once) instead of losing it. Consumers stay
    // idempotent (e.g. paymentStatus: { $ne: "paid" }).
    channel.sendToQueue(`${mainQueue}.retry`, msg.content, {
      persistent: true,
      expiration: String(delay),
      headers: {
        ...headers,
        "x-retry-count": retries + 1,
        "x-last-error": errorMessage,
      },
    });
    channel.ack(msg);

    console.warn(
      `[RETRY] ${mainQueue}: processing failed (attempt ${retries + 1}/${MAX_RETRIES}), redelivering in ${delay}ms — ${errorMessage}`,
    );
    return;
  }

  // Poison pill: stop retrying, park it in the DLQ and raise an alert.
  channel.sendToQueue(`${mainQueue}.dlq`, msg.content, {
    persistent: true,
    headers: {
      ...headers,
      "x-retry-count": retries,
      "x-last-error": errorMessage,
      "x-failed-at": new Date().toISOString(),
    },
  });
  channel.ack(msg);

  console.error(
    `[ALERT][DLQ] ${mainQueue}: message failed ${retries} times and was parked in ${mainQueue}.dlq — MANUAL INSPECTION REQUIRED — ${errorMessage}`,
  );
};
