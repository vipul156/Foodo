import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLE } from "@foodo/backend-common/aws";

// ─── Webhook event dedupe (DynamoDB) ─────────────────────────
// Providers redeliver webhooks (network blips, non-2xx responses), so
// every webhook is deduped on its provider event id before the
// payment-success event is published.
//
// The old in-memory window only protected within one process — useless
// across Lambda containers. The dedupe marker is now a DynamoDB row
// with a 24h TTL: a ConditionalCheckFailedException on the put means
// the event was seen. Durable guarantee downstream is unchanged — the
// restaurant consumer's conditional update (paymentStatus <> paid)
// makes duplicate deliveries no-ops regardless.

const ENTRY_TTL_SEC = 24 * 60 * 60; // 24h, then DynamoDB sweeps the row

export const isDuplicateEvent = async (eventId: string): Promise<boolean> => {
  const now = Math.floor(Date.now() / 1000);

  try {
    await docClient().send(
      new PutCommand({
        TableName: TABLE.webhookDedupe(),
        Item: {
          eventId, // PK
          seenAt: now,
          ttl: now + ENTRY_TTL_SEC,
        },
        ConditionExpression: "attribute_not_exists(eventId)",
      }),
    );
    return false; // first sighting — we claimed the marker
  } catch (error: any) {
    if (error?.name === "ConditionalCheckFailedException") {
      return true; // already seen
    }
    // Dedupe store unavailable: prefer processing (the downstream
    // consumer is idempotent) over dropping a real payment event.
    console.error("[WebhookDedupe] store unavailable:", error?.message);
    return false;
  }
};
