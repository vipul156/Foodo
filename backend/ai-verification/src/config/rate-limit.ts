import rateLimit, { Options } from "express-rate-limit";
import { createDynamoRateLimitStore } from "@foodo/backend-common/dynamo";

// ─── Rate limiting: shared DynamoDB counters ─────────────────
// The platform has no Redis. The in-memory default would give every
// concurrent Lambda container its OWN counter, so "120/min" would
// really mean "120/min per container". The DynamoDB store makes the
// limit real across every warm container of the service.
//
// The store fails OPEN (a limiter that takes down the packing gate is
// worse than a briefly-unlimited one) — the internal-key gate and the
// gateway are the real access controls.

const base: Partial<Options> = {
  standardHeaders: true,
  legacyHeaders: false,
};

// Visual verification: every call burns AI tokens + evidence storage.
// Callers are our own services (already authed by x-internal-key), so
// this is a runaway-loop guard, not a user-facing cap. 120/min per IP
// comfortably covers peak packing bursts at scale.
export const verificationLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 120,
  message: { message: "Verification rate exceeded" },
  store: createDynamoRateLimitStore({
    prefix: "verification",
    windowMs: 60_000,
    limit: 120,
  }),
  keyGenerator: (req) =>
    (req.headers["x-forwarded-for"] as string) || req.ip || "unknown",
});
