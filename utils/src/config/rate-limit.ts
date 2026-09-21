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

// Helper to create a store instance with a unique prefix per limiter
const createStore = (prefix: string) => {
  if (!redis) return undefined;
  return new RedisStore({
    sendCommand: (cmd: string, ...args: string[]) =>
      redis.call(cmd, ...args) as Promise<any>,
    prefix: `rl:${prefix}:`,
  });
};

const base: Partial<Options> = {
  standardHeaders: true,
  legacyHeaders: false,
};

// Payment-create endpoints: tight — money-adjacent, abuse-prone
const paymentStore = createStore("payment-create");
export const paymentCreateLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 10,
  message: { message: "Too many payment attempts — slow down" },
  ...(paymentStore ? { store: paymentStore } : {}),
});

// Webhooks: provider-originated and signature-verified
const webhookStore = createStore("webhook");
export const webhookLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 300,
  message: { message: "Webhook rate exceeded" },
  ...(webhookStore ? { store: webhookStore } : {}),
});