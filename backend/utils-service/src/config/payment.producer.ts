import { getChannelAsync } from "./rabbitmq.js";

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
    {persistent: true}
  );
};

// ─── payment.intent.created (fanout domain event) ───────────
// utils fires this right after creating a provider intent; the order
// owner's consumer stamps paymentIntent.providerOrderId (was an HTTP
// PUT to the restaurant service). Best-effort: a dropped publish costs
// one orphan provider intent (reconciliation flags it), never a wrong
// charge — the claim path's idempotent re-issue protects client retries.
export const publishPaymentIntentCreated = async (data: {
  orderId: string;
  provider: "razorpay" | "stripe";
  providerOrderId: string;
}): Promise<void> => {
  try {
    const channel = await getChannelAsync(5000);

    channel.publish(
      process.env.REALTIME_EXCHANGE || "order.status_changed",
      "",
      Buffer.from(JSON.stringify({ event: "payment.intent.created", room: undefined, payload: data })),
      { persistent: true },
    );
  } catch (error) {
    // Non-fatal by design — see the caller's comment.
    console.error(
      "payment.intent.created publish failed:",
      error instanceof Error ? error.message : error,
    );
  }
};
