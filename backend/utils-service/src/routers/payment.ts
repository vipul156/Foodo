import { Router } from "express";
import { createRazorpayOrder, createStripePaymentIntent, razorpayWebhook, stripeWebhook } from "../controllers/payment.js";
import { paymentCreateLimiter, webhookLimiter } from "../config/rate-limit.js";

const router = Router();

// Provider webhooks — the ONLY path that fulfills a payment. Routes live
// on a raw-body mount (see index.ts) so signatures verify against exact
// bytes. There is no client-driven verify endpoint by design; the frontend
// polls the order status endpoint instead.
// Bounded anyway: a runaway provider redelivery loop must not spin us.
router.post("/webhooks/razorpay", webhookLimiter, razorpayWebhook)
router.post("/webhooks/stripe", webhookLimiter, stripeWebhook)

// Tight limits: money-adjacent, abuse-prone.
router.post("/create", paymentCreateLimiter, createRazorpayOrder)
router.post("/stripe/create", paymentCreateLimiter, createStripePaymentIntent)

export default router;
