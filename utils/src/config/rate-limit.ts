import rateLimit, { Options } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { Redis } from "ioredis";

// ─── Rate limiting: Redis-backed across pods, memory fallback ──
// Counts must be shared across replicas for the limit to mean anything;
// a per-process memory store multiplies the limit by instance count.
// When REDIS_URL is unset (single-node dev), we fall back to the default
// in-memory store and say so.

const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;

const store = redis
  ? new RedisStore({
      // sendCommand is the documented bridge between ioredis and
      // rate-limit-redis
      sendCommand: (cmd: string, ...args: string[]) =>
        redis.call(cmd, ...args) as Promise<any>,
    })
  : undefined;

if (!redis) {
  console.warn(
    "[RateLimit] REDIS_URL not set — using in-memory store. Limits are per-process only; set REDIS_URL in multi-pod deployments.",
  );
}

const base: Partial<Options> = {
  standardHeaders: true, // RateLimit-* headers for clients/proxies
  legacyHeaders: false,
  ...(store ? { store } : {}),
};

// Payment-create endpoints: tight — money-adjacent, abuse-prone, and the
// downstream claim/attach calls are not free.
export const paymentCreateLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 10, // 10 payment creations / minute / IP
  message: { message: "Too many payment attempts — slow down" },
});

// Webhooks: provider-originated and signature-verified, so generous but
// still bounded — a runaway redelivery loop must not spin the service.
export const webhookLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 300,
  message: { message: "Webhook rate exceeded" },
});
