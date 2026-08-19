import { Request, Response } from "express";
import axios from "axios";
import razorpay from "../config/razorpay.js";
import crypto from "crypto";
import { verifyRazorpaySignature } from "../config/verifyRazorpay.js";
import { publishPaymentSuccess } from "../config/payment.producer.js";
import stripe from "../config/stripe.js";

export const createRazorpayOrder = async (req: Request, res: Response) => {
    try {
        const { orderId } = req.body;
        
        const {data} = await axios.get(
            `${process.env.RESTAURANT_SERVICE}/api/order/payment/${orderId}`,
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
            })
        
        res.status(200).json({ 
            razorpayOrderId: razorpayOrder.id,
            key: process.env.RAZORPAY_KEY_ID,
        });
    } catch (error) {
        res.status(500).json({ message: "Error creating order" });
    }
}

export const verifyRazorpayPayment = async (req: Request, res: Response) => {
    try {
        const { orderId, razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;
        
       const isValid = verifyRazorpaySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
        
       if(!isValid) {
        return res.status(400).json({ message: "Invalid signature" });
       }

       await publishPaymentSuccess({
        orderId,
        paymentId: razorpay_payment_id,
        provider: "razorpay",
       })

        res.status(200).json({ message: "Payment verified successfully" });
    } catch (error) {
        res.status(500).json({ message: "Error verifying payment" });
    }
}

export const createStripePaymentIntent = async (req: Request, res: Response) => {
    try {
        const { orderId } = req.body;
        
        const {data} = await axios.get(
            `${process.env.RESTAURANT_SERVICE}/api/order/payment/${orderId}`,
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

            success_url: `${process.env.FRONTEND_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.FRONTEND_URL}/payment/cancel`,
        })
        
        res.status(200).json({ 
            url: stripePaymentIntent.url,
        });
    } catch (error) {
        res.status(500).json({ message: "Error creating payment intent" });
    }
}


export const verifyStripePayment = async (req: Request, res: Response) => {
    try {
        const { sessionId } = req.body;
        
        const stripePaymentIntent = await stripe.checkout.sessions.retrieve(sessionId);
        
        if(!stripePaymentIntent) {
            return res.status(400).json({ message: "Invalid session id" });
        }

        const orderId = stripePaymentIntent.metadata?.orderId;
        if(!orderId) {
            return res.status(400).json({ message: "Invalid order id" });
        }
        
        await publishPaymentSuccess({
            orderId,
            paymentId: sessionId,
            provider: "stripe",
        })

        res.status(200).json({ message: "Payment verified successfully" });
    } catch (error) {
        res.status(500).json({ message: "Error verifying payment" });
    }
}
