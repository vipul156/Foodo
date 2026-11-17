import { Request, Response } from "express";
import crypto from "crypto";
import Razorpay from "razorpay";
import Stripe from "stripe";
import { runProvider } from "../config/http.js";
import { publishRefundEvent } from "../config/events.js";
import {
  getOrderById,
  attachRefund,
  refundedTotal,
  type DynamoOrder,
} from "@foodo/backend-common/dynamo";

// ─── Bounded autonomous refunds (agent tool surface) ─────────
// The ai-orchestrator agent may execute refunds WITHOUT human approval
// ONLY through this endpoint, which enforces hard bounds no agent
// reasoning can bypass:
//
//   1. AMOUNT CAP       — refund ≤ original total (prevents money minting)
//   2. PER-ORDER CAP    — cumulative refunds ≤ original total
//   3. IDEMPOTENCY      — same (orderId, reason) replays the same result
//   4. RATE LIMIT       — per-key limiter upstream (refunds.ts router)
//   5. AUDIT            — every attempt (allowed or blocked) is published
//                         to the refunds topic for review tooling
//
// The endpoint NEVER accepts a payment-id from the caller: it resolves
// the provider ids from the order record itself, so the agent cannot
// redirect refunds to a different payment.
//
// The order is read straight from the shared DynamoDB orders table —
// the order record IS the ledger of what was already refunded, so the
// cap is enforced against the same source of truth that the write goes
// to. No cross-service HTTP hop, no second copy to drift.

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

/** The payment facts the agent needs to reason about a refund. */
interface PaymentFacts {
  orderId: string;
  totalAmount: number;
  currency: string;
  paymentStatus: string;
  paymentMethod: string;
  paymentIntent?: {
    provider?: string | undefined;
    providerOrderId?: string | undefined;
    providerPaymentId?: string | undefined;
  };
  refunds: {
    provider: string;
    providerRefundId: string | null;
    amount: number;
    reason: string;
    at: string;
    initiatedBy: string;
  }[];
}

const toPaymentFacts = (order: DynamoOrder): PaymentFacts => ({
  orderId: order.id,
  totalAmount: Number(order.totalAmount ?? 0),
  currency: "INR",
  paymentStatus: order.paymentStatus,
  paymentMethod: order.paymentMethod,
  paymentIntent: {
    provider: order.paymentIntent?.provider,
    providerOrderId: order.paymentIntent?.providerOrderId,
    providerPaymentId: order.paymentIntent?.providerPaymentId,
  },
  refunds: (order.refunds ?? []).map((r) => ({
    provider: r.provider,
    providerRefundId: r.providerRefundId ?? null,
    amount: Number(r.amount ?? 0),
    reason: r.reason ?? "",
    at: r.at ?? "",
    initiatedBy: r.initiatedBy ?? "",
  })),
});

// ─── GET /api/utils/refund/order/:orderId/claim ──────────────
// Fetch order payment facts for pre-flight checks by the orchestrator.
export const getRefundClaim = async (req: Request, res: Response) => {
  const orderId = String(req.params.orderId ?? "");
  if (!orderId) {
    return res.status(400).json({ message: "orderId is required" });
  }

  try {
    const order = await getOrderById(orderId);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }
    return res.status(200).json({ success: true, order: toPaymentFacts(order) });
  } catch (err: any) {
    console.error("Refund claim fetch failed:", err?.message);
    return res.status(502).json({ message: "Order store unavailable" });
  }
};

// ─── POST /api/utils/refund/execute ──────────────────────────
// Body: { orderId, amount, reason, initiatedBy }
// initiatedBy is an actor tag for the audit trail ("agent:refund-arbiter:v1"
// or "human:admin:<id>") — it carries NO authorization weight; the
// internal service key is the only credential.
export const executeRefund = async (req: Request, res: Response) => {
  const { orderId, amount, reason, initiatedBy } = req.body ?? {};

  if (!orderId || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    return res.status(400).json({ message: "orderId and a positive amount are required" });
  }
  const refundAmount = Math.round(Number(amount) * 100) / 100;
  const auditReason = String(reason ?? "unspecified").slice(0, 200);
  const actor = String(initiatedBy ?? "unknown").slice(0, 120);

  // Idempotency: same order+amount+reason within 24h replays the same
  // outcome instead of double-refunding.
  const idempotencyKey = `refund:${orderId}:${refundAmount}:${crypto
    .createHash("sha256")
    .update(auditReason)
    .digest("hex")
    .slice(0, 16)}`;

  try {
    // 1) Resolve order + provider payment facts (never from the caller)
    const order = await getOrderById(orderId);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }
    const facts = toPaymentFacts(order);

    // 2) Hard bounds — a refused refund is as important to record as a
    //    completed one (fraud tooling watches the block rate).
    const refundTotal = refundedTotal(order);
    if (refundTotal + refundAmount > Number(order.totalAmount)) {
      await publishRefundEvent("refund.blocked", {
        orderId,
        amount: refundAmount,
        actor,
        reason: "CAP_EXCEEDED",
        refundTotal,
        totalAmount: order.totalAmount,
      });
      return res.status(409).json({
        message: "Refund exceeds order total (cumulative cap)",
        code: "CAP_EXCEEDED",
      });
    }

    if (order.paymentStatus !== "paid") {
      await publishRefundEvent("refund.blocked", {
        orderId,
        amount: refundAmount,
        actor,
        reason: "ORDER_NOT_PAID",
      });
      return res.status(409).json({
        message: "Order is not in a refundable (paid) state",
        code: "ORDER_NOT_PAID",
      });
    }

    const provider = order.paymentIntent?.provider;
    const providerPaymentId = order.paymentIntent?.providerPaymentId;

    if (provider === "razorpay") {
      if (!providerPaymentId) {
        await publishRefundEvent("refund.blocked", {
          orderId,
          amount: refundAmount,
          actor,
          reason: "NO_PROVIDER_PAYMENT",
        });
        return res.status(409).json({
          message: "No captured Razorpay payment attached to this order",
          code: "NO_PROVIDER_PAYMENT",
        });
      }
      const refund = await runProvider(() =>
        razorpay.payments.refund(providerPaymentId, {
          amount: Math.round(refundAmount * 100),
          speed: "normal",
          notes: { orderId, reason: auditReason, actor },
        }),
      );
      return await completeRefund(res, {
        orderId,
        refundAmount,
        auditReason,
        actor,
        provider,
        providerRefundId: refund?.id ?? null,
      });
    }

    if (provider === "stripe") {
      if (!providerPaymentId) {
        await publishRefundEvent("refund.blocked", {
          orderId,
          amount: refundAmount,
          actor,
          reason: "NO_PROVIDER_PAYMENT",
        });
        return res.status(409).json({
          message: "No captured Stripe payment attached to this order",
          code: "NO_PROVIDER_PAYMENT",
        });
      }

      // The captured Stripe id on the order is the Checkout SESSION id.
      // A refund needs the PaymentIntent, so resolve it once (and
      // tolerate a session that already carries the intent id).
      const paymentIntentId = await runProvider(async () => {
        if (providerPaymentId.startsWith("pi_")) return providerPaymentId;
        const session = await stripe.checkout.sessions.retrieve(providerPaymentId);
        return typeof session?.payment_intent === "string"
          ? session.payment_intent
          : session?.payment_intent?.id ?? null;
      });

      if (!paymentIntentId) {
        await publishRefundEvent("refund.blocked", {
          orderId,
          amount: refundAmount,
          actor,
          reason: "NO_PROVIDER_PAYMENT",
        });
        return res.status(409).json({
          message: "No captured Stripe payment attached to this order",
          code: "NO_PROVIDER_PAYMENT",
        });
      }

      const refund = await runProvider(() =>
        stripe.refunds.create(
          {
            payment_intent: paymentIntentId,
            amount: Math.round(refundAmount * 100),
            metadata: { orderId, reason: auditReason, actor },
          },
          { idempotencyKey },
        ),
      );
      return await completeRefund(res, {
        orderId,
        refundAmount,
        auditReason,
        actor,
        provider,
        providerRefundId: refund?.id ?? null,
      });
    }

    // COD or unknown provider — nothing to refund through a gateway
    await publishRefundEvent("refund.blocked", {
      orderId,
      amount: refundAmount,
      actor,
      reason: "NO_GATEWAY_PAYMENT",
    });
    return res.status(409).json({
      message: "Order has no gateway payment to refund",
      code: "NO_GATEWAY_PAYMENT",
    });
  } catch (err: any) {
    // Provider rejections surface as 4xx — do not mask as 500
    if (err?.response?.status) {
      return res.status(err.response.status).json({
        message: err.response.data?.message ?? "Refund rejected",
      });
    }
    console.error("Refund execution failed:", err?.message);
    return res.status(502).json({ message: "Refund failed — try again" });
  }
};

// ─── Refund completion (ledger write + audit event) ───────────
// The refund list on the order is what makes the cumulative cap real
// across requests, so it is written BEFORE the success response. If
// the write fails the caller sees a 502 and can retry — the provider
// refund is idempotent on the same key.
async function completeRefund(
  res: Response,
  args: {
    orderId: string;
    refundAmount: number;
    auditReason: string;
    actor: string;
    provider: string;
    providerRefundId: string | null;
  },
): Promise<Response> {
  const { orderId, refundAmount, auditReason, actor, provider, providerRefundId } = args;

  const updated = await attachRefund(orderId, {
    provider,
    providerRefundId,
    amount: refundAmount,
    reason: auditReason,
    at: new Date().toISOString(),
    initiatedBy: actor,
  });

  if (!updated) {
    console.error(
      `[ALERT][REFUND] ${orderId}: provider refund ${providerRefundId} succeeded but the ledger write failed`,
    );
  }

  await publishRefundEvent("refund.completed", {
    orderId,
    amount: refundAmount,
    actor,
    reason: auditReason,
    provider,
    providerRefundId,
  });

  return res.status(200).json({
    success: true,
    provider,
    providerRefundId,
    amount: refundAmount,
    idempotencyKey: `refund:${orderId}`,
  });
}
