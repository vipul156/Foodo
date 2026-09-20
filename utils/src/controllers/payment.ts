import { Request, Response } from "express";
import {
  claimOrderViaBreaker,
  attachOrderViaBreaker,
  runProvider,
} from "../config/http.js";
import razorpay from "../config/razorpay.js";
import crypto from "crypto";
import { publishPaymentSuccess } from "../config/payment.producer.js";
import { isDuplicateEvent } from "../config/webhookDedupe.js";
import stripe from "../config/stripe.js";

// Internal auth header shared by every order-owner call
const internalHeaders = {
  "x-internal-key": process.env.INTERNAL_SERVICE_KEY,
};

// ─── Order-owner claim/attach helpers ───────────────────────
// The restaurant service owns orders: it atomically claims the order for
// payment (rejecting paid/cancelled/expired) and remembers the created
// provider intent so client retries re-issue the SAME one.
interface OrderPaymentClaim {
  orderId: string;
  amount: number;
  currency: string;
  attachedProviderOrderId: string | null;
}

const claimOrderPayment = async (
  orderId: string,
  provider: "razorpay" | "stripe",
): Promise<OrderPaymentClaim> => {
  // Critical pool + breaker: a dead order service trips the circuit and
  // checkout fails fast instead of piling up sockets.
  return claimOrderViaBreaker<OrderPaymentClaim>(
    `${process.env.RESTAURANT_SERVICE_URL}/api/order/payment/claim/${orderId}`,
    provider,
    { headers: internalHeaders },
  );
};

const attachProviderOrder = async (
  orderId: string,
  provider: "razorpay" | "stripe",
  providerOrderId: string,
) => {
  await attachOrderViaBreaker(
    `${process.env.RESTAURANT_SERVICE_URL}/api/order/payment/attached/${orderId}`,
    { provider, providerOrderId },
    { headers: internalHeaders },
  );
};

export const createRazorpayOrder = async (req: Request, res: Response) => {
    try {
        const { orderId } = req.body;

        if (!orderId) {
            return res.status(400).json({ message: "orderId is required" });
        }

        // Atomic claim: rejects paid/cancelled/expired orders and returns
        // any previously attached Razorpay order — double-clicks (and retry
        // storms) re-issue the SAME intent instead of creating duplicates.
        // The amount comes from the claim, so it can't race an order update.
        const claim = await claimOrderPayment(orderId, "razorpay");

        if (claim.attachedProviderOrderId) {
            return res.status(200).json({
                razorpayOrderId: claim.attachedProviderOrderId,
                key: process.env.RAZORPAY_KEY_ID,
            });
        }

        const razorpayOrder = await runProvider(() =>
          razorpay.orders.create({
            amount: claim.amount * 100,
            currency: claim.currency ?? "INR",
            receipt: orderId,
            // Notes ride along on every webhook payment entity, so the
            // webhook can resolve the internal orderId without an API
            // round-trip.
            notes: { orderId },
          }),
        );

        // Remember it on the order so every future create returns the same one
        try {
            await attachProviderOrder(orderId, "razorpay", razorpayOrder.id);
        } catch (attachError: any) {
            // Worst case is an orphan provider order — the reconciliation
            // job flags those for manual cleanup.
            console.error(
                `[ALERT][RECONCILE] Failed to attach razorpay order ${razorpayOrder.id} to ${orderId}:`,
                attachError?.message,
            );
        }

        res.status(200).json({ 
            razorpayOrderId: razorpayOrder.id,
            key: process.env.RAZORPAY_KEY_ID,
        });
    } catch (error: any) {
        // Claim conflicts (paid/cancelled/expired) surface as 409 from the owner
        if (error?.response?.status === 409) {
            return res
                .status(409)
                .json({ message: error.response.data?.message ?? "Order not payable" });
        }
        console.error("Razorpay create order error:", error?.message);
        res.status(500).json({ message: "Error creating order" });
    }
}

// ─── Razorpay Webhook (source of truth) ─────────────────────
// There is intentionally NO client-driven verify endpoint: payment
// fulfillment comes exclusively from this signature-verified webhook,
// checked against the raw request body with RAZORPAY_WEBHOOK_SECRET.
// The frontend polls the order status endpoint instead.
export const razorpayWebhook = async (req: Request, res: Response) => {
    try {
        // Webhook routes use express.raw() — req.body is the raw Buffer.
        const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}));
        const signature = req.headers["x-razorpay-signature"];

        if (typeof signature !== "string") {
            return res.status(400).json({ message: "Missing signature" });
        }

        const expected = crypto
            .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET!)
            .update(rawBody)
            .digest("hex");

        const a = Buffer.from(expected);
        const b = Buffer.from(signature);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            console.error("Razorpay webhook: invalid signature");
            return res.status(400).json({ message: "Invalid signature" });
        }

        const event = JSON.parse(rawBody.toString());
        const type = event?.event as string | undefined;

        // Only funds-actually-captured events mark an order paid
        if (type !== "payment.captured" && type !== "order.paid") {
            return res.status(200).json({ message: "Event ignored" });
        }

        const eventId = req.headers["x-razorpay-event-id"];
        if (typeof eventId === "string" && isDuplicateEvent(eventId)) {
            return res.status(200).json({ message: "Duplicate event" });
        }

        const payment = event.payload?.payment?.entity;
        const orderEntity = event.payload?.order?.entity;

        // Resolve the internal orderId: notes (set at creation) → order
        // receipt (order.paid events) → Razorpay API lookup as last resort.
        let orderId: string | undefined =
            payment?.notes?.orderId ?? orderEntity?.receipt;

        if (!orderId && payment?.order_id) {
            const rzpOrder = await razorpay.orders.fetch(payment.order_id);
            orderId = rzpOrder?.receipt ?? undefined;
        }

        if (!orderId) {
            console.error("Razorpay webhook: cannot resolve internal orderId", {
                type,
                paymentId: payment?.id,
            });
            return res.status(400).json({ message: "Cannot resolve orderId" });
        }

        await publishPaymentSuccess({
            orderId,
            paymentId: payment?.id ?? "unknown",
            provider: "razorpay",
        });

        return res.status(200).json({ message: "Webhook processed" });
    } catch (error: any) {
        console.error("Razorpay webhook error:", error?.message);
        // Non-2xx tells Razorpay to redeliver — safe because of event dedupe
        // and the downstream idempotent consumer.
        return res.status(500).json({ message: "Webhook processing failed" });
    }
}

// ─── Stripe Webhook (source of truth) ───────────────────────
// checkout.session.completed is Stripe's guaranteed delivery of the money
// fact; the browser-driven /stripe/verify stays UX-only.
export const stripeWebhook = async (req: Request, res: Response) => {
    try {
        const signature = req.headers["stripe-signature"];

        if (typeof signature !== "string") {
            return res.status(400).json({ message: "Missing signature" });
        }

        // constructEvent verifies the signature against the raw bytes and
        // throws on mismatch — provider-authenticated by construction.
        const event = stripe.webhooks.constructEvent(
            Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {})),
            signature,
            process.env.STRIPE_WEBHOOK_SECRET!,
        );

        if (event.type !== "checkout.session.completed") {
            return res.status(200).json({ message: "Event ignored" });
        }

        if (isDuplicateEvent(event.id)) {
            return res.status(200).json({ message: "Duplicate event" });
        }

        const session = event.data.object as {
            id: string;
            payment_status?: string;
            metadata?: Record<string, string> | null;
        };

        const orderId = session.metadata?.orderId;
        if (!orderId) {
            console.error("Stripe webhook: session missing orderId metadata", {
                sessionId: session.id,
            });
            return res.status(400).json({ message: "Cannot resolve orderId" });
        }

        if (session.payment_status !== "paid") {
            // Session completed but payment unsettled (async methods) —
            // do NOT mark the order paid; the paid event arrives separately.
            return res.status(200).json({ message: "Payment not settled" });
        }

        await publishPaymentSuccess({
            orderId,
            paymentId: session.id,
            provider: "stripe",
        });

        return res.status(200).json({ message: "Webhook processed" });
    } catch (error: any) {
        console.error("Stripe webhook error:", error?.message);
        // 400 for signature failures makes Stripe stop retrying bad traffic;
        // constructEvent errors all land here, which is the desired drop.
        return res.status(400).json({ message: "Invalid webhook" });
    }
}

export const createStripePaymentIntent = async (req: Request, res: Response) => {
    try {
        const { orderId } = req.body;

        if (!orderId) {
            return res.status(400).json({ message: "orderId is required" });
        }

        // Same atomic claim as Razorpay: idempotent re-issue + trusted amount
        const claim = await claimOrderPayment(orderId, "stripe");

        if (claim.attachedProviderOrderId) {
            const existing = await runProvider(() =>
                stripe.checkout.sessions.retrieve(claim.attachedProviderOrderId!),
            );
            if (existing?.url) {
                return res.status(200).json({ url: existing.url });
            }
            // No url (e.g. expired) → fall through and create a fresh one;
            // the idempotency key below still guards duplicate creation.
        }

        const stripePaymentIntent = await runProvider(async () =>
          stripe.checkout.sessions.create({
           payment_method_types: ["card"],
            mode: "payment",
            
            line_items: [
                {
                    price_data: {
                        currency: "inr",
                        product_data: {
                            name: "Order Payment",
                        },
                        unit_amount: claim.amount * 100,
                    },
                    quantity: 1,
                },
            ],

            metadata: {
                orderId,
            },

            // orderId rides in the return URL so the success page can poll
            // the read-only status endpoint while the webhook lands.
            success_url: `${process.env.FRONTEND_URL}/payment/success?orderId=${orderId}&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.FRONTEND_URL}/payment/cancel`,
        },
        // Stripe-native idempotency: retries with this key return the same
        // session instead of creating a new one.
        { idempotencyKey: `order_${orderId}` }));

        try {
            await attachProviderOrder(orderId, "stripe", stripePaymentIntent.id);
        } catch (attachError: any) {
            console.error(
                `[ALERT][RECONCILE] Failed to attach stripe session ${stripePaymentIntent.id} to ${orderId}:`,
                attachError?.message,
            );
        }
        
        res.status(200).json({ 
            url: stripePaymentIntent.url,
        });
    } catch (error: any) {
        if (error?.response?.status === 409) {
            return res
                .status(409)
                .json({ message: error.response.data?.message ?? "Order not payable" });
        }
        console.error("Stripe create session error:", error?.message);
        res.status(500).json({ message: "Error creating payment intent" });
    }
}


