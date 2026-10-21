import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import agentRouter from "./routes/agent.js";

// ─── AI arbiter (stateless HTTP, Lambda-mounted) ─────────────
// No MongoDB connection and no broker: case state lives in the shared
// DynamoDB tables, events ride the platform's SNS topic, and dispute
// intake is enqueued onto the SQS agent-disputes queue (consumed by the
// disputeConsumer Lambda). The service boots instantly and stays up
// even when every dependency is down — arbitration failures are recorded
// as failed cases, never lost requests.
//
// Exports `app` (not a listening server): src/handlers/http.ts wraps it
// with serverless-http, matching the sibling services' layout.

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

const app = express();

// Internal tooling + health probes only — no browser ever talks to the
// AI tier directly (disputes are proxied by the platform API).
app.use(cors({ origin: FRONTEND_URL, credentials: true }));

// ─── Body limits: scoped headroom ────────────────────────────
// A dispute intake may carry a compressed base64 photo (~14M chars
// worst case). The scoped parser MUST be registered before the global
// 1mb one — Express matches middleware in order.
app.use(
  "/api/agent/dispute",
  express.json({ limit: "15mb" }),
  express.urlencoded({ limit: "15mb", extended: true }),
);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ limit: "1mb", extended: true }));

app.use("/api/agent", agentRouter);

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "UP",
    uptime: process.uptime(),
    timestamp: Date.now(),
  });
});

export { app };
