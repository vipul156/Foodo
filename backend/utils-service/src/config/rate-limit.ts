import rateLimit, { Options } from "express-rate-limit";

// ─── Rate limiting on Lambda ─────────────────────────────────
// The old Redis-backed store is gone: each Lambda container is a
// short-lived isolated process, so a shared external counter would be
// the only correct store — and that now belongs at the edge, not in
// app code. Two layers cover it:
//
//   1. In-memory express-rate-limit here: per-warm-container, still
//      blunts bursts that land on the same container (webhook
//      redelivery storms included).
//   2. API Gateway per-client usage plans / throttling (IaC): the real
//      per-IP enforcement point for a serverless deployment.
//
// The 15-min in-memory brute-force counter in auth-service follows the
// same reasoning and stays as-is.

const base: Partial<Options> = {
  standardHeaders: true,
  legacyHeaders: false,
};

// Payment-create endpoints: tight — money-adjacent, abuse-prone
export const paymentCreateLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 10,
  message: { message: "Too many payment attempts — slow down" },
});

// Webhooks: provider-originated and signature-verified
export const webhookLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 300,
  message: { message: "Webhook rate exceeded" },
});
