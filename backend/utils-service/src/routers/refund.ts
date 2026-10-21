import { Router } from "express";
import rateLimit from "express-rate-limit";
import { createDynamoRateLimitStore } from "@foodo/backend-common/dynamo";
import { executeRefund, getRefundClaim } from "../controllers/refund.js";
import { isInternal } from "../middlewares/isInternal.js";

// ─── Refund endpoints (agent tool surface) ───────────────────
// The isInternal key gate is the credential; the rate limiter is the
// blast-radius guard: even a runaway agent loop can move at most
// 30 refund attempts per minute, and the per-order + per-amount caps
// in the controller bound total exposure.
//
// The counter lives in DynamoDB (the platform has no Redis). The
// in-memory default would give every concurrent Lambda container its
// OWN counter — "30/min" would really mean "30/min per container" —
// so the shared DynamoDB store is what makes the limit real.

const refundLimiter = rateLimit({
  standardHeaders: true,
  legacyHeaders: false,
  windowMs: 60_000,
  limit: 30,
  message: { message: "Refund rate exceeded" },
  store: createDynamoRateLimitStore({
    prefix: "refund",
    windowMs: 60_000,
    limit: 30,
  }),
  keyGenerator: (req) =>
    (req.headers["x-forwarded-for"] as string) || req.ip || "unknown",
});

const router = Router();

router.use(isInternal);
router.use(refundLimiter);

router.get("/order/:orderId/claim", getRefundClaim);
router.post("/execute", executeRefund);

export default router;
