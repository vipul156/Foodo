import express from "express";
import dotenv from "dotenv";
import cloudinary from "cloudinary";
import cors from "cors";
import { cloudinaryRouter } from "./routers/cloudinary.js";
import { connectRabbitMQ } from "./config/rabbitmq.js";
import { startPaymentReconciliation } from "./config/reconciliation.js";
import paymentRouter from "./routers/payment.js";

dotenv.config();

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

const app = express();

// ─── CORS: strict origin whitelist ─────────────────────────
// This service processes PAYMENTS and file uploads — with a bare cors()
// any origin could drive payment creation or abuse the upload endpoint.
// Locked to the frontend origin with credentials, same as the other
// services. (Provider webhooks are exempt by nature: Razorpay/Stripe
// server-to-server POSTs send no Origin header, which cors() allows.)
app.use(
  cors({
    origin: FRONTEND_URL,
    credentials: true,
  }),
);

// ─── Body parser: restrictive default, scoped override ─────
// ORDER MATTERS. The 15mb upload parser must be registered BEFORE the
// global 1mb parser — the global one would otherwise reject oversized
// upload bodies with a 413 before the scoped parser is ever reached.
//
// Webhook signature verification needs the exact raw bytes — raw() runs
// first and body-parser skips already-parsed bodies afterwards.

// 1) Webhooks: raw bytes only (before any JSON parser)
app.use("/api/utils/payment/webhooks", express.raw({ type: "application/json" }));

// 2) Upload route: the ONLY path with a raised cap. Internal callers
//    (restaurant/rider services) forward base64 image data URIs here.
app.use(
  "/api/utils/upload",
  express.json({ limit: "15mb" }),
  express.urlencoded({ limit: "15mb", extended: true }),
);

// 3) Global default: 1mb is far above any legit JSON body this API
//    accepts (payments, internal claims). The old 50mb global limit was
//    a trivial DoS amplification — every request could force 50MB of
//    memory churn.
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ limit: "1mb", extended: true }));

// ─── Routers ────────────────────────────────────────────────
app.use("/api/utils/", cloudinaryRouter);
app.use("/api/utils/payment", paymentRouter);

connectRabbitMQ();
// Periodic provider-vs-database payment audit (missed-webhook safety net)
startPaymentReconciliation();

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'UP',
    uptime: process.uptime(),
    timestamp: Date.now()
  });
});

const PORT = process.env.PORT || 3005
app.listen(PORT, () => {
    console.log("Server running on port ", PORT);
});
