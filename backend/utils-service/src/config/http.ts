import axios, { AxiosRequestConfig } from "axios";
import CircuitBreaker from "opossum";

// ─── Bulkhead pools + circuit breakers ──────────────────────
// POOL A (critical) — payment claim/attach against the order owner.
//                     Checkout latency depends on this pool only.
//
// (The reconciliation job's order-owner fetch now reads in-process over
// the shared schemas in @foodo/backend-common/models — no HTTP client.)
//
// Every dependency gets its own opossum breaker: repeated failures trip
// the circuit OPEN (fail fast, no socket pile-up on a dead downstream);
// after a cool-down a single half-open probe decides whether to resume.

const INTERNAL_TIMEOUT_MS = Number(process.env.INTERNAL_HTTP_TIMEOUT_MS) || 3000;
const PROVIDER_TIMEOUT_MS = Number(process.env.PROVIDER_HTTP_TIMEOUT_MS) || 8000;

const breakerDefaults = {
  errorThresholdPercentage: 50, // trip when >50% of the window fails
  rollingCountTimeout: 10_000, // 10s statistics window
  rollingCountBuckets: 10,
  resetTimeout: 10_000, // half-open single probe after 10s
};

function breakerWrap<TArgs extends unknown[], TResult>(
  name: string,
  timeoutMs: number,
  fn: (...args: TArgs) => Promise<TResult>,
): CircuitBreaker<TArgs, TResult> {
  const breaker = new CircuitBreaker<TArgs, TResult>(fn, {
    ...breakerDefaults,
    timeout: timeoutMs,
  });
  // Visibility: state changes are the earliest signal of a dying dependency.
  breaker.on("open", () => console.error(`[BREAKER OPEN] ${name} — failing fast`));
  breaker.on("halfOpen", () => console.warn(`[BREAKER HALF-OPEN] ${name} — probing`));
  breaker.on("close", () => console.log(`[BREAKER CLOSED] ${name} — recovered`));
  return breaker;
}

// ─── Pool A: critical payment path ──────────────────────────
const criticalClient = axios.create({
  timeout: INTERNAL_TIMEOUT_MS,
});

interface ClaimArgs {
  url: string;
  provider: string;
  config: AxiosRequestConfig;
}

const claimBreaker = breakerWrap<[ClaimArgs], { data: unknown }>(
  "order-claim",
  INTERNAL_TIMEOUT_MS,
  async ({ url, provider, config }) => {
    const response = await criticalClient.post(url, { provider }, config);
    return { data: response.data };
  },
);

export const claimOrderViaBreaker = async <T>(
  url: string,
  provider: string,
  config: AxiosRequestConfig,
): Promise<T> => {
  const { data } = (await claimBreaker.fire({ url, provider, config })) as {
    data: T;
  };
  return data;
};

interface AttachArgs {
  url: string;
  body: unknown;
  config: AxiosRequestConfig;
}

const attachBreaker = breakerWrap<[AttachArgs], void>(
  "order-attach",
  INTERNAL_TIMEOUT_MS,
  async ({ url, body, config }) => {
    await criticalClient.put(url, body, config);
  },
);

export const attachOrderViaBreaker = async (
  url: string,
  body: unknown,
  config: AxiosRequestConfig,
): Promise<void> => {
  await attachBreaker.fire({ url, body, config });
};

// ─── Payment provider calls (external, 8s leeway) ───────────
// One shared-open circuit for ALL provider endpoints: a Razorpay/Stripe
// outage trips once for everything instead of per-endpoint retries each
// paying the full failure cost. The 8s ceiling gives external gateways
// leeway while protecting threads from hanging forever.
const providerBreaker = breakerWrap<[() => Promise<unknown>], unknown>(
  "payment-provider",
  PROVIDER_TIMEOUT_MS,
  async (fn) => fn(),
);

export const runProvider = async <T>(fn: () => Promise<T>): Promise<T> =>
  (await providerBreaker.fire(fn)) as T;
