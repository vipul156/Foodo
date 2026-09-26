import {
  ScanCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { docClient, TABLE } from "@foodo/backend-common/aws";
import razorpay from "./razorpay.js";
import stripe from "./stripe.js";
import { publishPaymentSuccess } from "./events.js";

// ─── Payment Reconciliation (EventBridge-triggered Lambda) ───
// Safety net for missed/dropped webhooks: the order table reports
// pending orders with an initiated payment intent; this job asks the
// provider for the truth.
//   - Money captured on the provider → republish payment success through
//     the SAME queue webhooks use (the consumer's conditional update
//     keeps it idempotent — heals the order exactly like a webhook).
//   - Created-but-never-paid intents → flagged as orphans for review.
//
// Scheduling: an EventBridge Scheduler rule invokes the exported
// `reconcile` handler on a rate(1 hour) cron (IaC wires the target
// later). The setInterval/timeout boot code is gone — Lambda has no
// background timers.

interface ReconciliationCandidate {
  orderId: string;
  paymentIntent?: {
    provider?: string;
    providerOrderId?: string;
  };
}

const fetchCandidates = async (
  olderThanMinutes: number,
): Promise<ReconciliationCandidate[]> => {
  // Direct read over the orders table. Payment-status queries ride the
  // payment-status GSI (paymentStatus + initiatedAt) so this stays a
  // targeted query, not a table scan.
  const since = new Date(Date.now() - olderThanMinutes * 60 * 1000)
    .toISOString();

  const out = await docClient().send(
    new QueryCommand({
      TableName: TABLE.orders(),
      IndexName: "payment-status",
      KeyConditionExpression:
        "paymentStatus = :pending AND paymentIntentInitiatedAt <= :since",
      ExpressionAttributeValues: {
        ":pending": "pending",
        ":since": since,
      },
      Limit: 100,
    }),
  );

  return ((out.Items ?? []) as any[])
    .map((o) => ({
      orderId: o.id as string,
      paymentIntent: o.paymentIntent,
    }))
    .filter((c) => c.orderId);
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

export const runPaymentReconciliation = async (): Promise<{
  audited: number;
}> => {
  const olderThanMinutes = 20; // matches the 15-min unpaid-order window
  const candidates = await fetchCandidates(olderThanMinutes);

  if (candidates.length === 0) {
    return { audited: 0 };
  }

  console.log(`[RECONCILE] auditing ${candidates.length} pending payment(s)`);

  for (const candidate of candidates) {
    const { orderId } = candidate;
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
        console.log(
          `[RECONCILE] ${provider} ${providerOrderId} (${orderId}): ${outcome}`,
        );
      }
    } catch (err: any) {
      // Provider hiccup on one candidate must not abort the audit
      console.error(
        `[ALERT][RECONCILE] failed to audit ${provider} ${providerOrderId} for order ${orderId}:`,
        err?.message,
      );
    }
  }

  return { audited: candidates.length };
};

// EventBridge Scheduler target — every Lambda invocation is one audit
// pass. CloudWatch collects the [RECONCILE] logs; alarm on
// "[ALERT][RECONCILE]" for orphan/capture anomalies.
export const reconcile = async () => {
  const result = await runPaymentReconciliation();
  return {
    statusCode: 200,
    body: JSON.stringify({ audited: result.audited }),
  };
};
