import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { cloudinaryRouter } from "./routers/cloudinary.js";
import paymentRouter from "./routers/payment.js";



export const app = express();

// ─── Body parser: restrictive default, scoped override ─────
// ORDER MATTERS. The 15mb upload parser must be registered BEFORE the
// global 1mb parser — the global one would otherwise reject oversized
// upload bodies with a 413 before the scoped parser is ever reached.
//
// Webhook signature verification needs the exact raw bytes — raw() runs
// first and body-parser skips already-parsed bodies afterwards.

// 1) Webhooks: raw bytes only (before any JSON parser)
app.use("/api/utils/payment/webhooks", express.raw({ type: "application/json" }));

// 2) [REMOVED] The 15mb upload parser — the /upload proxy is deprecated
//    (see routers/cloudinary.ts). Signed direct uploads no longer send
//    image bytes through this service.

// 3) Global default: 1mb is far above any legit JSON body this API
//    accepts (payments, internal claims). The old 50mb global limit was
//    a trivial DoS amplification — every request could force 50MB of
//    memory churn.
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ limit: "1mb", extended: true }));

// ─── Routers ────────────────────────────────────────────────
app.use("/api/utils/", cloudinaryRouter);
app.use("/api/utils/payment", paymentRouter);

// The reconciliation job is an EventBridge Scheduler target invoking the
// exported `reconcile` handler — no setInterval boot code (Lambda has no
// background timers).

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'UP',
    uptime: process.uptime(),
    timestamp: Date.now()
  });
});
