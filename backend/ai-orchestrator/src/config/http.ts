import axios, { AxiosRequestConfig } from "axios";
import CircuitBreaker from "opossum";
import {
  authHeaders,
  buildChatJsonPayload,
  chatCompletionsUrl,
  extractChatJson,
  resolveLlmConfig,
  type LlmUsage,
} from "@foodo/backend-common/llm";

// ─── Isolated egress pools ───────────────────────────────────
// POOL A — internal service calls (order facts, refunds via utils).
// POOL B — LLM providers (vision triage + evidence summarization).
// A provider outage must never eat the sockets the refund path needs,
// and vice versa: isolation by client, breaker per dependency.

const INTERNAL_TIMEOUT_MS = Number(process.env.INTERNAL_HTTP_TIMEOUT_MS) || 5000;
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 30_000;

const breakerDefaults = {
  errorThresholdPercentage: 50,
  rollingCountTimeout: 10_000,
  rollingCountBuckets: 10,
  resetTimeout: 15_000,
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

// ─── Pool A: internal services ───────────────────────────────
const internalClient = axios.create({ timeout: INTERNAL_TIMEOUT_MS });

interface InternalArgs {
  url: string;
  config?: AxiosRequestConfig | undefined;
  body?: unknown;
}

const internalGetBreaker = breakerWrap<[InternalArgs], unknown>(
  "orchestrator-internal-get",
  INTERNAL_TIMEOUT_MS,
  async ({ url, config }) => {
    const response = await internalClient.get(url, config);
    return response.data;
  },
);

const internalPostBreaker = breakerWrap<[InternalArgs], unknown>(
  "orchestrator-internal-post",
  INTERNAL_TIMEOUT_MS,
  async ({ url, body, config }) => {
    const response = await internalClient.post(url, body, config);
    return response.data;
  },
);

export const internalGet = async <T>(
  url: string,
  config?: AxiosRequestConfig,
): Promise<T> => (await internalGetBreaker.fire({ url, config })) as T;

export const internalPost = async <T>(
  url: string,
  body?: unknown,
  config?: AxiosRequestConfig,
): Promise<T> => (await internalPostBreaker.fire({ url, body, config })) as T;

export const getInternalHeaders = () => ({
  "x-internal-key": process.env.INTERNAL_SERVICE_KEY || "",
});

// ─── Pool B: LLM (OpenAI-compatible) ─────────────────────────
// One transport for every vendor: LLM_PROVIDER / LLM_MODEL / LLM_API_KEY
// (+ LLM_BASE_URL) pick the endpoint and the model, which must accept
// image_url content parts and response_format=json_object. temperature 0
// for reproducible classifications; JSON-only outputs, defensively parsed.

const llmClient = axios.create({ timeout: LLM_TIMEOUT_MS });

export type { LlmUsage };

interface LlmArgs {
  system: string;
  userText: string;
  imageBase64?: string | null;
  maxTokens?: number;
}

async function callLlmRaw(
  args: LlmArgs,
): Promise<{ json: Record<string, unknown> | null; usage: LlmUsage | null }> {
  // Unconfigured deployment: no endpoint, so skip egress entirely.
  const cfg = resolveLlmConfig();
  if (!cfg) return { json: null, usage: null };

  const response = await llmClient.post(
    chatCompletionsUrl(cfg),
    buildChatJsonPayload(cfg, args),
    { headers: authHeaders(cfg) },
  );

  return extractChatJson(response.data);
}

const llmBreaker = breakerWrap<
  [LlmArgs],
  { json: Record<string, unknown> | null; usage: LlmUsage | null }
>("llm-chat", LLM_TIMEOUT_MS, callLlmRaw);

export const callLlm = async (args: LlmArgs) => {
  try {
    return await llmBreaker.fire(args);
  } catch (err) {
    console.error("LLM call failed:", err instanceof Error ? err.message : err);
    return { json: null, usage: null };
  }
};
