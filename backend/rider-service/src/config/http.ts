import axios, { AxiosRequestConfig } from "axios";
import CircuitBreaker from "opossum";

// ─── Bulkhead pools + circuit breakers ──────────────────────
//   POOL A (critical) — order status updates (picked_up / delivered),
//                       the one remaining WRITE call to the restaurant
//                       service. Rider payouts flow from these.
//
// (Reads for rider dashboards now run in-process over the shared
// schemas in @foodo/backend-common/models — no HTTP client needed.)
//
// Each pool is breaker-wrapped (opossum): repeated failures trip the
// circuit OPEN (fail fast, no socket pile-up on a dead downstream);
// after a cool-down a single half-open probe decides whether to resume.

const INTERNAL_TIMEOUT_MS = Number(process.env.INTERNAL_HTTP_TIMEOUT_MS) || 3000;

const breakerDefaults = {
  errorThresholdPercentage: 50, // trip when >50% of the window fails
  rollingCountTimeout: 10_000, // 10s statistics window
  rollingCountBuckets: 10,
  resetTimeout: 10_000, // half-open single probe after 10s
  // no allowWarmUp — opossum's option is boolean-gated; cold-start noise
  // is absorbed by the 50% threshold + 10s window instead
};

function breakerWrap<TResult>(
  name: string,
  fn: (args: { url: string; config: AxiosRequestConfig; body?: unknown }) => Promise<TResult>,
) {
  const breaker = new CircuitBreaker(fn, {
    ...breakerDefaults,
    timeout: INTERNAL_TIMEOUT_MS,
  });
  breaker.on("open", () => console.error(`[BREAKER OPEN] ${name} — failing fast`));
  breaker.on("halfOpen", () => console.warn(`[BREAKER HALF-OPEN] ${name} — probing`));
  breaker.on("close", () => console.log(`[BREAKER CLOSED] ${name} — recovered`));
  return breaker;
}

// ─── Pool A: critical (order status updates) ────────────────
// NOTE: axios (v1) manages its own connection pool per client — the
// bulkhead isolation comes from using SEPARATE clients, not socket caps.
const criticalClient = axios.create({
  timeout: INTERNAL_TIMEOUT_MS,
});

const criticalPutBreaker = breakerWrap(
  "rider-critical-put",
  async ({ url, body, config }) => {
    const response = await criticalClient.put(url, body, config);
    return response.data;
  },
);

export const criticalPut = async <T>(
  url: string,
  body: unknown,
  config: AxiosRequestConfig,
): Promise<T> =>
  (await criticalPutBreaker.fire({ url, body, config })) as T;

// Raw client for callers with bespoke needs (still timeout-bounded)
export const http = criticalClient;
