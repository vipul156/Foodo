import { Router } from "express";
import { createRazorpayOrder, createStripePaymentIntent, razorpayWebhook, stripeWebhook } from "../controllers/payment.js";

const router = Router();

// Provider webhooks — the ONLY path that fulfills a payment. Routes live
// on a raw-body mount (see index.ts) so signatures verify against exact
// bytes. There is no client-driven verify endpoint by design; the frontend
// polls the order status endpoint instead.
router.post("/webhooks/razorpay", razorpayWebhook)
router.post("/webhooks/stripe", stripeWebhook)

router.post("/create",createRazorpayOrder)
router.post("/stripe/create",createStripePaymentIntent)

export default router;
