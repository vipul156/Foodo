import axios, { AxiosRequestConfig } from "axios";
import CircuitBreaker from "opossum";

// ─── Verification pool (isolated bulkhead) ───────────────────
// A third dedicated pool for the utils AI verification tier. If the AI
// tier is slow or down, ONLY this pool degrades — the critical rider-
// release path and the upload pool stay fully untouched (isolation by
// client), and the breaker fails fast instead of piling up sockets.

const VERIFICATION_TIMEOUT_MS =
  Number(process.env.VERIFICATION_HTTP_TIMEOUT_MS) || 20_000;

const breakerDefaults = {
  errorThresholdPercentage: 50,
  rollingCountTimeout: 10_000,
  rollingCountBuckets: 10,
  resetTimeout: 15_000,
};

const verificationClient = axios.create({
  timeout: VERIFICATION_TIMEOUT_MS,
});

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

interface VerifyArgs {
  url: string;
  body: unknown;
  config: AxiosRequestConfig;
}

const verifyBreaker = breakerWrap<[VerifyArgs], { data: unknown }>(
  "utils-verification",
  VERIFICATION_TIMEOUT_MS,
  async ({ url, body, config }) => {
    const response = await verificationClient.post(url, body, config);
    return { data: response.data };
  },
);

export const verifyViaBreaker = async <T>(
  url: string,
  body: unknown,
  config: AxiosRequestConfig,
): Promise<T> => {
  const { data } = (await verifyBreaker.fire({ url, body, config })) as {
    data: T;
  };
  return data;
};
