import {
  makeDomainEventPublisher,
  sendWorkItem,
} from "@foodo/backend-common/aws";

// ─── Event wiring (utils-service, AWS) ───────────────────────
// Replaces config/rabbitmq.ts + payment.producer.ts:
//
//   PAYMENT_QUEUE (work)  → SQS PAYMENT_QUEUE_URL (restaurant consumes)
//   fanout exchange       → SNS topic (payment.intent.created)
//
// Payment success travels on the PAYMENT_QUEUE work queue ({ type, data }
// envelope) — the restaurant-service consumer applies it idempotently.
// Throws on failure so the webhook handler returns 5xx and the provider
// redelivers (webhook dedupe keeps it safe) — same contract as before.
export const publishPaymentSuccess = async (paymentData: {
  orderId: string;
  /** The CAPTURED provider id (Razorpay `pay_…`, Stripe Checkout `cs_…`). */
  providerPaymentId: string;
  provider: "razorpay" | "stripe";
}): Promise<void> => {
  const queueUrl = process.env.PAYMENT_QUEUE_URL;
  if (!queueUrl) {
    throw new Error("PAYMENT_QUEUE_URL is not configured");
  }
  await sendWorkItem(queueUrl, "PAYMENT_SUCCESS", paymentData);
};

// ─── payment.intent.created (SNS domain event) ───────────────
// utils fires this right after creating a provider intent; the order
// owner's consumer stamps paymentIntent.providerOrderId. Best-effort:
// a dropped publish costs one orphan provider intent (reconciliation
// flags it), never a wrong charge — the claim path's idempotent
// re-issue protects client retries.
export const publishPaymentIntentCreated = makeDomainEventPublisher();

// ─── Refund audit events (SNS domain event) ──────────────────
// Every refund attempt — allowed OR blocked — is published here.
// Review tooling / fraud dashboards subscribe with a filter policy on
// the event name; the order's own `refunds` list stays the
// authoritative ledger for the cumulative cap.
//
// Best-effort by design: the money already moved (or was already
// refused) by the time we publish, so a dropped event must not turn a
// successful refund into an error response.
const publishRefundDomainEvent = makeDomainEventPublisher();

export const publishRefundEvent = async (
  type: "refund.completed" | "refund.blocked",
  data: unknown,
): Promise<void> => {
  await publishRefundDomainEvent(type, { ...(data as object), at: new Date().toISOString() });
};
