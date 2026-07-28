import { Router } from "express";
import { createRazorpayOrder, verifyRazorpayPayment, createStripePaymentIntent, verifyStripePayment } from "../controllers/payment.js";

const router = Router();

router.post("/create",createRazorpayOrder)
router.post("/verify",verifyRazorpayPayment)
router.post("/stripe/verify",verifyStripePayment)
router.post("/stripe/create",createStripePaymentIntent)

export default router;
