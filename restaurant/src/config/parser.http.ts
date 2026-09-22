import axios, { AxiosRequestConfig } from "axios";
import CircuitBreaker from "opossum";

// ─── AI Menu Parser pool (isolated bulkhead) ─────────────────
// Vision parsing can take seconds (image fetch + LLM). This pool is
// deliberately separate from the critical release / verification /
// upload pools: a slow parser degrades ONLY menu import, never order
// flow. The breaker fails fast while the Python service recovers.

const PARSER_TIMEOUT_MS = Number(process.env.PARSER_HTTP_TIMEOUT_MS) || 45_000;

const breakerDefaults = {
  errorThresholdPercentage: 50,
  rollingCountTimeout: 10_000,
  rollingCountBuckets: 10,
  resetTimeout: 20_000,
};

const parserClient = axios.create({ timeout: PARSER_TIMEOUT_MS });

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

interface ParserArgs {
  url: string;
  body?: unknown | undefined;
  config?: AxiosRequestConfig | undefined;
}

const parserBreaker = breakerWrap<[ParserArgs], { data: unknown }>(
  "ai-menu-parser",
  PARSER_TIMEOUT_MS,
  async ({ url, body, config }) => {
    const response = body !== undefined
      ? await parserClient.post(url, body, config)
      : await parserClient.get(url, config);
    return { data: response.data };
  },
);

export const parserViaBreaker = async <T>(
  url: string,
  body: unknown,
  config?: AxiosRequestConfig,
): Promise<T> => {
  const { data } = (await parserBreaker.fire({ url, body, config })) as {
    data: T;
  };
  return data;
};
