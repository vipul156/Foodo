import { Router } from "express";
import rateLimit from "express-rate-limit";
import { submitDispute, getCase, getEscalatedQueue } from "../controllers/dispute.js";
import { isInternal } from "../middlewares/isInternal.js";

const router = Router();

// Dispute intake: called by the frontend support flow (through the
// Next.js rewrite / admin service proxy). Tight limit — filing disputes
// is user-driven and money-adjacent.
const disputeLimiter = rateLimit({
  standardHeaders: true,
  legacyHeaders: false,
  windowMs: 60_000,
  limit: 10,
  keyGenerator: (req) =>
    (req.headers["x-forwarded-for"] as string) || req.ip || "unknown",
  message: { message: "Too many disputes filed — slow down" },
});

router.post("/dispute", disputeLimiter, submitDispute);

// Case reads: the support UI polls these for live progress. Keep the
// thought-graph (steps) visible to authenticated tooling.
router.get("/case/:caseId", getCase);

// Review queue: internal only (admin service)
router.get("/queue", isInternal, getEscalatedQueue);

export default router;
