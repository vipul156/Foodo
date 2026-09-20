import { Router } from "express";
import { createRazorpayOrder, verifyRazorpayPayment, createStripePaymentIntent, verifyStripePayment, razorpayWebhook, stripeWebhook } from "../controllers/payment.js";

const router = Router();

// Provider webhooks — source of truth for payment success. Routes live on
// a raw-body mount (see index.ts) so signatures verify against exact bytes.
router.post("/webhooks/razorpay", razorpayWebhook)
router.post("/webhooks/stripe", stripeWebhook)

router.post("/create",createRazorpayOrder)
router.post("/verify",verifyRazorpayPayment)
router.post("/stripe/verify",verifyStripePayment)
router.post("/stripe/create",createStripePaymentIntent)

export default router;
