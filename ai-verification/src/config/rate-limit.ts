import rateLimit, { Options } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { Redis } from "ioredis";

// ─── Rate limiting: Redis-backed across pods, memory fallback ──
const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;

if (!redis) {
  console.warn(
    "[RateLimit] REDIS_URL not set — using in-memory store. Limits are per-process only; set REDIS_URL in multi-pod deployments.",
  );
}

const createStore = (prefix: string) => {
  if (!redis) return undefined;
  return new RedisStore({
    sendCommand: (cmd: string, ...args: string[]) =>
      redis.call(cmd, ...args) as Promise<any>,
    prefix: `rl:verification:${prefix}:`,
  });
};

const base: Partial<Options> = {
  standardHeaders: true,
  legacyHeaders: false,
};

// Visual verification: every call burns AI tokens + evidence storage.
// Callers are our own services (already authed by x-internal-key), so
// this is a runaway-loop guard, not a user-facing cap. 120/min per IP
// comfortably covers peak packing bursts at scale.
const verificationStore = createStore("verify");
export const verificationLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 120,
  message: { message: "Verification rate exceeded" },
  ...(verificationStore ? { store: verificationStore } : {}),
});
