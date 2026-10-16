import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLE } from "@foodo/backend-common/aws";
import razorpay from "./razorpay.js";
import stripe from "./stripe.js";
import { publishPaymentSuccess } from "./events.js";

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
  const since = new Date(Date.now() - olderThanMinutes * 60 * 1000).toISOString();

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

export const runPaymentReconciliation = async (): Promise<{ audited: number }> => {
  const olderThanMinutes = 20;
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
      console.error(
        `[ALERT][RECONCILE] failed to audit ${provider} ${providerOrderId} for order ${orderId}:`,
        err?.message,
      );
    }
  }

  return { audited: candidates.length };
};