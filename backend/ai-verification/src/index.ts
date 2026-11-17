import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import { verificationRouter } from "./routers/verification.js";

// ─── AI verification service (stateless HTTP) ─────────────────
// No MongoDB connection and no broker: verdicts live in the shared
// DynamoDB table, events ride the platform's SNS topic. The service
// boots instantly and stays up even when every dependency is down —
// a dead AI tier degrades to "unverified", it never 5xx.

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

const app = express();

// Internal-only service: callers are the restaurant/rider services (and
// admin tooling). CORS stays locked to the frontend origin purely so
// health probes from browser devtools don't noise up logs — no browser
// ever calls the AI tier directly.
app.use(cors({ origin: FRONTEND_URL, credentials: true }));

// ─── Body limits: scoped headroom ────────────────────────────
// Every verification request carries a compressed base64 photo (~14M
// chars worst case). The default 1mb parser must be registered AFTER
// the scoped one — Express matches middleware in order.
app.use(
  "/api/verification",
  express.json({ limit: "15mb" }),
  express.urlencoded({ limit: "15mb", extended: true }),
);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ limit: "1mb", extended: true }));

app.use("/api/verification", verificationRouter);

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "UP",
    uptime: process.uptime(),
    timestamp: Date.now(),
  });
});

// Exports `app` (not a listening server): src/handlers/http.ts wraps it
// with serverless-http, matching the sibling services' layout.
export { app };
