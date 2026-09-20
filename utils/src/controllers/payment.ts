import { Request, Response } from "express";
import axios from "axios";
import razorpay from "../config/razorpay.js";
import crypto from "crypto";
import { publishPaymentSuccess } from "../config/payment.producer.js";
import { isDuplicateEvent } from "../config/webhookDedupe.js";
import stripe from "../config/stripe.js";

export const createRazorpayOrder = async (req: Request, res: Response) => {
    try {
        const { orderId } = req.body;
        
        const {data} = await axios.get(
            `${process.env.RESTAURANT_SERVICE_URL}/api/order/payment/${orderId}`,
            {
                headers: {
                    "x-internal-key": process.env.INTERNAL_SERVICE_KEY,
                },
            }
        )

        const razorpayOrder = await razorpay.orders.create({
                amount: data.amount * 100,
                currency: "INR",
                receipt: orderId,
                // Notes ride along on every webhook payment entity, so the
                // webhook can resolve the internal orderId without an API
                // round-trip.
                notes: { orderId },
            })
        
        res.status(200).json({ 
            razorpayOrderId: razorpayOrder.id,
            key: process.env.RAZORPAY_KEY_ID,
        });
    } catch (error: any) {
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
        
        const {data} = await axios.get(
            `${process.env.RESTAURANT_SERVICE_URL}/api/order/payment/${orderId}`,
            {
                headers: {
                    "x-internal-key": process.env.INTERNAL_SERVICE_KEY,
                },
            }
        )

        const stripePaymentIntent = await stripe.checkout.sessions.create({
           payment_method_types: ["card"],
            mode: "payment",
            
            line_items: [
                {
                    price_data: {
                        currency: "inr",
                        product_data: {
                            name: "Order Payment",
                        },
                        unit_amount: data.amount * 100,
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
        })
        
        res.status(200).json({ 
            url: stripePaymentIntent.url,
        });
    } catch (error: any) {
        console.error("Stripe create session error:", error?.message);
        res.status(500).json({ message: "Error creating payment intent" });
    }
}


