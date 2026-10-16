import {
  makeDomainEventPublisher,
  sendWorkItem,
} from "@foodo/backend-common/aws";

// ─── Event wiring (utils-service, AWS) ───────────────────────
// Replaces config/rabbitmq.ts + payment.producer.ts:
//
//   PAYMENT_QUEUE (work)  → SQS PAYMENT_QUEUE_URL (restaurant consumes)
//   fanout exchange       → SNS topic (payment.intent.created)

// Payment success travels on the PAYMENT_QUEUE work queue ({ type, data }
// envelope) — the restaurant-service consumer applies it idempotently.
// Throws on failure so the webhook handler returns 5xx and the provider
// redelivers (webhook dedupe keeps it safe) — same contract as before.
export const publishPaymentSuccess = async (paymentData: {
  orderId: string;
  paymentId: string;
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
