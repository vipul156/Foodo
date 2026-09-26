import {
  makeDomainEventPublisher,
} from "@foodo/backend-common/queue";
import { manager, getChannelAsync } from "./rabbitmq.js";

// ─── Publishers (utils-service) ─────────────────────────────

// Payment success travels on the PAYMENT_QUEUE work queue ({ type, data }
// envelope) — the restaurant-service consumer applies it idempotently.
// A persistent outage surfaces as an exception the webhook handler turns
// into a 5xx, so the provider redelivers (webhook dedupe keeps it safe).
export const publishPaymentSuccess = async (paymentData: {
  orderId: string;
  paymentId: string;
  provider: "razorpay" | "stripe"
}) => {
  const channel = await getChannelAsync();
  channel.sendToQueue(
    process.env.PAYMENT_QUEUE!,
    Buffer.from(
      JSON.stringify({
        type: "PAYMENT_SUCCESS",
        data: paymentData
      })
    ),
    { persistent: true },
  );
};

// ─── payment.intent.created (fanout domain event) ───────────
// utils fires this right after creating a provider intent; the order
// owner's consumer stamps paymentIntent.providerOrderId (was an HTTP
// PUT to the restaurant service). Best-effort: a dropped publish costs
// one orphan provider intent (reconciliation flags it), never a wrong
// charge — the claim path's idempotent re-issue protects client retries.
// Built on the shared bounded-wait domain-event publisher.
export const publishPaymentIntentCreated = makeDomainEventPublisher(manager);
