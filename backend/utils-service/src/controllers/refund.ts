import { Request, Response } from "express";
import crypto from "crypto";
import Razorpay from "razorpay";
import Stripe from "stripe";
import axios from "axios";
import { runProvider } from "../config/http.js";
import { getChannel } from "../config/rabbitmq.js";

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
//                         to the refunds exchange for review tooling
//
// The endpoint NEVER accepts a payment-id from the caller: it resolves
// the provider ids from the order record itself, so the agent cannot
// redirect refunds to a different payment.

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

// Internal claims (server-to-server, internal-key gated upstream)
interface OrderClaim {
  success: boolean;
  order: {
    _id: string;
    totalAmount: number;
    currency?: string;
    paymentStatus: string;
    paymentMethod: string;
    paymentIntent?: {
      provider?: string;
      providerOrderId?: string;
      providerPaymentId?: string;
    };
    refunds?: {
      provider: string;
      providerRefundId: string;
      amount: number;
      reason: string;
      at: string;
      initiatedBy: string;
    }[];
  };
}

const RESTAURANT_TIMEOUT_MS = Number(process.env.INTERNAL_HTTP_TIMEOUT_MS) || 3000;

const orderClient = axios.create({ timeout: RESTAURANT_TIMEOUT_MS });

// ─── GET /api/utils/refund/order/:orderId/claim ──────────────
// Fetch order payment facts for pre-flight checks by the orchestrator.
export const getRefundClaim = async (req: Request, res: Response) => {
  const { orderId } = req.params;
  if (!orderId) {
    return res.status(400).json({ message: "orderId is required" });
  }

  try {
    const response = await orderClient.get(
      `${process.env.RESTAURANT_SERVICE_URL}/api/order/payment/${orderId}`,
      { headers: { "x-internal-key": process.env.INTERNAL_SERVICE_KEY } },
    );
    const order = response.data?.order;
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }
    return res.status(200).json({ success: true, order });
  } catch (err: any) {
    if (err?.response?.status === 404) {
      return res.status(404).json({ message: "Order not found" });
    }
    console.error("Refund claim fetch failed:", err?.message);
    return res.status(502).json({ message: "Order service unavailable" });
  }
};

// ─── POST /api/utils/refund/execute ──────────────────────────
// Body: { orderId, amount, reason, initiatedBy }
// initiatedBy is an actor tag for the audit trail ("agent:refund-agent:v1"
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
    const response = await orderClient.get(
      `${process.env.RESTAURANT_SERVICE_URL}/api/order/payment/${orderId}`,
      { headers: { "x-internal-key": process.env.INTERNAL_SERVICE_KEY } },
    );
    const order: OrderClaim["order"] | undefined = response.data?.order;
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    // 2) Hard bounds — a refused refund is as important to record as a
    //    completed one (fraud tooling watches the block rate).
    const refundTotal = (order.refunds ?? []).reduce(
      (sum, r) => sum + Number(r.amount || 0),
      0,
    );
    if (refundTotal + refundAmount > Number(order.totalAmount)) {
      publishRefundEvent("refund.blocked", {
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
      publishRefundEvent("refund.blocked", {
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
      publishRefundEvent("refund.completed", {
        orderId,
        amount: refundAmount,
        actor,
        reason: auditReason,
        provider,
        providerRefundId: refund?.id ?? null,
      });
      return res.status(200).json({
        success: true,
        provider,
        providerRefundId: refund?.id ?? null,
        amount: refundAmount,
        idempotencyKey,
      });
    }

    if (provider === "stripe") {
      if (!providerPaymentId) {
        return res.status(409).json({
          message: "No captured Stripe payment attached to this order",
          code: "NO_PROVIDER_PAYMENT",
        });
      }
      const refund = await runProvider(() =>
        stripe.refunds.create(
          {
            payment_intent: providerPaymentId,
            amount: Math.round(refundAmount * 100),
            metadata: { orderId, reason: auditReason, actor },
          },
          { idempotencyKey },
        ),
      );
      publishRefundEvent("refund.completed", {
        orderId,
        amount: refundAmount,
        actor,
        reason: auditReason,
        provider,
        providerRefundId: refund?.id ?? null,
      });
      return res.status(200).json({
        success: true,
        provider,
        providerRefundId: refund?.id ?? null,
        amount: refundAmount,
        idempotencyKey,
      });
    }

    // COD or unknown provider — nothing to refund through a gateway
    publishRefundEvent("refund.blocked", {
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

// ─── Refund audit events (fanout) ────────────────────────────
// Review tooling / fraud dashboards subscribe without touching this path.

function publishRefundEvent(type: "refund.completed" | "refund.blocked", data: unknown) {
  const channel = getChannel();
  if (!channel) {
    console.error(`Refund publish failed (${type}): RabbitMQ not connected`);
    return;
  }
  channel.publish(
    process.env.REFUND_EXCHANGE || "refund.events",
    "",
    Buffer.from(JSON.stringify({ type, data, at: new Date().toISOString() })),
    { persistent: true },
  );
}
