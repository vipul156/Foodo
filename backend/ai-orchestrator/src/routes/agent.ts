import { Router } from "express";
import rateLimit from "express-rate-limit";
import { submitDispute, getCase, getOrderCases, getEscalatedQueue } from "../controllers/dispute.js";
import { isInternal } from "../middlewares/isInternal.js";
import { createDynamoRateLimitStore } from "@foodo/backend-common/dynamo";

// ─── Rate limiting: shared DynamoDB counters ─────────────────
// The platform has no Redis. The in-memory default would give every
// concurrent Lambda container its OWN counter, so "10/min per IP"
// would really be "10/min per warm container". The DynamoDB store
// makes the limit real across the whole service. It fails OPEN (the
// internal-key gate and the gateway are the real access controls).

const router = Router();

// Dispute intake: called by the frontend support flow (through the
// platform API). Tight limit — filing disputes is user-driven and
// money-adjacent.
const disputeLimiter = rateLimit({
  standardHeaders: true,
  legacyHeaders: false,
  windowMs: 60_000,
  limit: 10,
  keyGenerator: (req) =>
    (req.headers["x-forwarded-for"] as string) || req.ip || "unknown",
  message: { message: "Too many disputes filed — slow down" },
  store: createDynamoRateLimitStore({
    prefix: "agent-dispute",
    windowMs: 60_000,
    limit: 10,
  }),
});

router.post("/dispute", disputeLimiter, submitDispute);

// Case reads: the support UI polls these for live progress. Keep the
// thought-graph (steps) visible to authenticated tooling.
const caseReadLimiter = rateLimit({
  standardHeaders: true,
  legacyHeaders: false,
  windowMs: 60_000,
  limit: 60,
  keyGenerator: (req) =>
    (req.headers["x-forwarded-for"] as string) || req.ip || "unknown",
  store: createDynamoRateLimitStore({
    prefix: "agent-case-read",
    windowMs: 60_000,
    limit: 60,
  }),
});
router.get("/case/:caseId", caseReadLimiter, getCase);
// Order-scoped read: the order page asks "is there already a case for
// this order?" instead of remembering a case id in the browser.
router.get("/order/:orderId/cases", caseReadLimiter, getOrderCases);

// Review queue: internal only (admin tooling)
router.get("/queue", isInternal, getEscalatedQueue);

export default router;
