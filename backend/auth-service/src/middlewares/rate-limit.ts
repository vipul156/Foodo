import rateLimit, { Options, ipKeyGenerator } from "express-rate-limit";
import { NextFunction, Request, Response } from "express";

// ─── Auth rate limiting ─────────────────────────────────────
// Two layers:
//   1. General per-IP flood limiter on credential endpoints — blunts
//      naive floods.
//   2. Failure-only brute-force counter keyed by IP+email — an attacker
//      with many IPs still burns the targeted ACCOUNT's budget, and a
//      legitimate user's successful logins never count against them.
//
// Store: in-memory (per-process). When auth scales past a couple of
// pods, plug in the Redis store (rate-limit-redis + REDIS_URL) the same
// way the utils service does.

const base: Partial<Options> = {
  standardHeaders: true,
  legacyHeaders: false,
};

// Use the library's official IPv6-safe helper
const ipKey = (req: Request): string => ipKeyGenerator(req.ip ?? "unknown");

const ipEmailKey = (req: Request): string =>
  `${ipKeyGenerator(req.ip ?? "unknown")}:${
    typeof req.body?.email === "string" ? req.body.email.toLowerCase() : "no-email"
  }`;

// 1) General flood guard: 20 credential attempts / 5 min / IP
export const authFloodLimiter = rateLimit({
  ...base,
  windowMs: 5 * 60_000,
  limit: 20,
  keyGenerator: ipKey,
  message: { message: "Too many attempts — try again later" },
});

// 2) Failure-only brute-force guard: 10 failures / 15 min / IP+email.
// express-rate-limit counts every matched request, so failures are
// tracked separately and the limiter itself is driven by a middleware
// that consults those counters before the route handler runs.
const failureCounts = new Map<string, { count: number; resetAt: number }>();
const FAILURE_WINDOW_MS = 15 * 60_000;
const FAILURE_LIMIT = 10;

// Record a failed credential attempt (call from the login/register
// controllers' error paths).
export const recordAuthFailure = (req: Request): void => {
  const key = ipEmailKey(req);
  const now = Date.now();
  const entry = failureCounts.get(key);

  if (!entry || entry.resetAt <= now) {
    failureCounts.set(key, { count: 1, resetAt: now + FAILURE_WINDOW_MS });
    return;
  }
  entry.count += 1;
};

// Clear failures for an IP+email after a successful login.
export const clearAuthFailures = (req: Request): void => {
  failureCounts.delete(ipEmailKey(req));
};

// Opportunistic cleanup so the map can't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of failureCounts) {
    if (entry.resetAt <= now) failureCounts.delete(key);
  }
}, 60_000).unref();

export const bruteForceLimiter = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const entry = failureCounts.get(ipEmailKey(req));

  if (entry && entry.resetAt > Date.now() && entry.count >= FAILURE_LIMIT) {
    res.status(429).json({
      message: "Too many failed attempts — try again later",
    });
    return;
  }
  next();
};