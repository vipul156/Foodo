import { Router } from "express";
import rateLimit from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { Redis } from "ioredis";
import { executeRefund, getRefundClaim } from "../controllers/refund.js";
import { isInternal } from "../middlewares/isInternal.js";

// ─── Refund endpoints (agent tool surface) ───────────────────
// The isInternal key gate is the credential; the rate limiter is the
// blast-radius guard: even a runaway agent loop can move at most
// 30 refund attempts per minute, and the per-order + per-amount caps
// in the controller bound total exposure.

const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;

const refundStore = redis
  ? new RedisStore({
      sendCommand: (cmd: string, ...args: string[]) =>
        redis.call(cmd, ...args) as Promise<any>,
      prefix: "rl:refund:",
    })
  : undefined;

const refundLimiter = rateLimit({
  standardHeaders: true,
  legacyHeaders: false,
  windowMs: 60_000,
  limit: 30,
  message: { message: "Refund rate exceeded" },
  ...(refundStore ? { store: refundStore } : {}),
});

const router = Router();

router.use(isInternal);
router.use(refundLimiter);

router.get("/order/:orderId/claim", getRefundClaim);
router.post("/execute", executeRefund);

export default router;
