import axios, { AxiosRequestConfig } from "axios";
import CircuitBreaker from "opossum";

// ─── Bulkhead pools + circuit breakers ──────────────────────
//   POOL A (critical)     — the rider-release compensation call: when a
//                           seller cancels an order with a rider on it,
//                           this must go through even under load.
//   POOL B (non-critical) — the base64 image forward to the upload
//                           service (menu-item / restaurant create).
//                           Uploads can retry; payouts can't.
//
// Each pool is breaker-wrapped (opossum): repeated failures trip the
// circuit OPEN (fail fast, no socket pile-up); after a cool-down a
// single half-open probe decides whether to resume.

const INTERNAL_TIMEOUT_MS = Number(process.env.INTERNAL_HTTP_TIMEOUT_MS) || 3000;

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
  breaker.on("open", () => console.error(`[BREAKER OPEN] ${name} — failing fast`));
  breaker.on("halfOpen", () => console.warn(`[BREAKER HALF-OPEN] ${name} — probing`));
  breaker.on("close", () => console.log(`[BREAKER CLOSED] ${name} — recovered`));
  return breaker;
}

// ─── Pool A: critical (rider release compensation) ──────────
const criticalClient = axios.create({
  timeout: INTERNAL_TIMEOUT_MS,
});

interface ReleaseArgs {
  url: string;
  body: unknown;
  config: AxiosRequestConfig;
}

const releaseBreaker = breakerWrap<[ReleaseArgs], void>(
  "rider-release",
  INTERNAL_TIMEOUT_MS,
  async ({ url, body, config }) => {
    await criticalClient.put(url, body, config);
  },
);

export const releaseRiderViaBreaker = async (
  url: string,
  body: unknown,
  config: AxiosRequestConfig,
): Promise<void> => {
  await releaseBreaker.fire({ url, body, config });
};

// Raw critical client (timeout-bounded) for the rare direct call
export const http = criticalClient;

// ─── Pool B: non-critical (upload forward) ──────────────────
const uploadClient = axios.create({
  timeout: 15_000, // base64 payloads are large; give the forward leeway
});

interface UploadArgs {
  url: string;
  body: unknown;
}

const uploadBreaker = breakerWrap<[UploadArgs], { data: { url?: string } }>(
  "upload-forward",
  15_000,
  async ({ url, body }) => {
    const response = await uploadClient.post(url, body);
    return { data: response.data };
  },
);

export const uploadViaBreaker = async <T>(
  url: string,
  body: unknown,
): Promise<T> => {
  const { data } = (await uploadBreaker.fire({ url, body })) as {
    data: T;
  };
  return data;
};
