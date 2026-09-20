import http from "./http.js";
import razorpay from "./razorpay.js";
import stripe from "./stripe.js";
import { publishPaymentSuccess } from "./payment.producer.js";

// ─── Payment Reconciliation Job ─────────────────────────────
// Safety net for missed/dropped webhooks: the order owner reports pending
// orders with an initiated payment intent; this job asks the provider for
// the truth.
//   - Money captured on the provider → republish payment success through
//     the SAME queue webhooks use (the consumer's conditional update keeps
//     it idempotent — this heals the order exactly like a webhook would).
//   - Created-but-never-paid intents → flagged as orphans for manual review.
// Runs hourly by default; override with PAYMENT_RECONCILE_INTERVAL_MS.

interface ReconciliationCandidate {
  _id: string;
  paymentIntent?: {
    provider?: string;
    providerOrderId?: string;
  };
}

const fetchCandidates = async (
  olderThanMinutes: number,
): Promise<ReconciliationCandidate[]> => {
  const { data } = await http.get<{
    success: boolean;
    count: number;
    orders: ReconciliationCandidate[];
  }>(
    `${process.env.RESTAURANT_SERVICE_URL}/api/order/payment/reconciliation`,
    {
      params: { olderThanMinutes },
      headers: { "x-internal-key": process.env.INTERNAL_SERVICE_KEY },
    },
  );
  return data?.orders ?? [];
};

const reconcileRazorpay = async (
  orderId: string,
  providerOrderId: string,
): Promise<string> => {
  const rzpOrder = await razorpay.orders.fetch(providerOrderId);

  if (rzpOrder.status === "paid") {
    // Money captured but no webhook landed — heal through the normal path
    const payments = await razorpay.orders.fetchPayments(providerOrderId);
    const captured = payments.items?.find((p) => p.status === "captured");
    await publishPaymentSuccess({
      orderId,
      paymentId: captured?.id ?? rzpOrder.id,
      provider: "razorpay",
    });
    return "republished (captured on provider, webhook was missed)";
  }

  if (rzpOrder.status === "created") {
    return "still pending on provider";
  }

  return `unexpected provider status: ${rzpOrder.status}`;
};

const reconcileStripe = async (
  orderId: string,
  sessionId: string,
): Promise<string> => {
  const session = await stripe.checkout.sessions.retrieve(sessionId);

  if (session.payment_status === "paid") {
    await publishPaymentSuccess({
      orderId,
      paymentId: session.id,
      provider: "stripe",
    });
    return "republished (captured on provider, webhook was missed)";
  }

  if (session.status === "expired") {
    return "ORPHAN: session expired without payment";
  }

  return "still pending on provider";
};

export const runPaymentReconciliation = async (): Promise<void> => {
  const olderThanMinutes = 20; // matches the 15-min unpaid-order window
  const candidates = await fetchCandidates(olderThanMinutes);

  if (candidates.length === 0) {
    return;
  }

  console.log(`[RECONCILE] auditing ${candidates.length} pending payment(s)`);

  for (const candidate of candidates) {
    const { _id: orderId } = candidate;
    const { provider, providerOrderId } = candidate.paymentIntent ?? {};

    if (!providerOrderId || (provider !== "razorpay" && provider !== "stripe")) {
      continue;
    }

    try {
      const outcome =
        provider === "razorpay"
          ? await reconcileRazorpay(orderId, providerOrderId)
          : await reconcileStripe(orderId, providerOrderId);

      if (outcome.startsWith("ORPHAN") || outcome.startsWith("unexpected")) {
        console.error(
          `[ALERT][RECONCILE] ${provider} ${providerOrderId} for order ${orderId}: ${outcome} — MANUAL INSPECTION REQUIRED`,
        );
      } else {
        console.log(`[RECONCILE] ${provider} ${providerOrderId} (${orderId}): ${outcome}`);
      }
    } catch (err: any) {
      // Provider hiccup on one candidate must not abort the audit
      console.error(
        `[ALERT][RECONCILE] failed to audit ${provider} ${providerOrderId} for order ${orderId}:`,
        err?.message,
      );
    }
  }
};

export const startPaymentReconciliation = () => {
  const interval =
    Number(process.env.PAYMENT_RECONCILE_INTERVAL_MS) || 60 * 60 * 1000;

  // First pass shortly after boot, then on the interval
  setTimeout(() => {
    runPaymentReconciliation().catch((err) =>
      console.error("[ALERT][RECONCILE] job failed:", err?.message),
    );
    setInterval(
      () =>
        runPaymentReconciliation().catch((err) =>
          console.error("[ALERT][RECONCILE] job failed:", err?.message),
        ),
      interval,
    );
  }, 30_000);

  console.log(
    `Payment reconciliation scheduled every ${Math.round(interval / 1000)}s`,
  );
};
