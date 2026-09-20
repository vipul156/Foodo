// ─── Webhook event dedupe ───────────────────────────────────
// Providers redeliver webhooks (network blips, non-2xx responses), so every
// webhook is deduped on its provider event id before the payment-success
// event is published. Utils keeps no database, so this is an in-memory
// window: it protects within one instance. The durable guarantee lives
// downstream — the restaurant consumer's conditional update
// (paymentStatus: { $ne: "paid" }) makes duplicate deliveries no-ops.

const SEEN_EVENTS = new Map<string, number>();
const MAX_ENTRIES = 5000;
const ENTRY_TTL_MS = 24 * 60 * 60 * 1000;

const prune = (now: number) => {
  for (const [id, ts] of SEEN_EVENTS) {
    if (now - ts > ENTRY_TTL_MS) {
      SEEN_EVENTS.delete(id);
    }
  }
  // Hard cap for hostile/duplicated traffic bursts
  while (SEEN_EVENTS.size > MAX_ENTRIES) {
    SEEN_EVENTS.delete(SEEN_EVENTS.keys().next().value!);
  }
};

export const isDuplicateEvent = (eventId: string): boolean => {
  const now = Date.now();

  if (SEEN_EVENTS.has(eventId)) {
    return true;
  }

  SEEN_EVENTS.set(eventId, now);
  prune(now);
  return false;
};
