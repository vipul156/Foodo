import axios, { AxiosRequestConfig } from "axios";
import CircuitBreaker from "opossum";

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

// ─── Pool B: LLM providers ───────────────────────────────────
// Claude Haiku: fast, cheap, vision-capable — used for complaint
// parsing, photo triage, and escalation summaries. temperature 0 for
// reproducible classifications; JSON-only outputs, defensively parsed.

const llmClient = axios.create({
  timeout: LLM_TIMEOUT_MS,
  headers: {
    "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  },
});

export interface LlmUsage {
  prompt: number;
  completion: number;
}

interface LlmArgs {
  system: string;
  userText: string;
  imageBase64?: string | null;
  maxTokens?: number;
}

async function callClaude(args: LlmArgs): Promise<{ json: Record<string, unknown> | null; usage: LlmUsage | null }> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { json: null, usage: null };

  const model = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";

  const content: unknown[] = [];
  if (args.imageBase64) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: args.imageBase64 },
    });
  }
  content.push({ type: "text", text: args.userText });

  const response = await llmClient.post("https://api.anthropic.com/v1/messages", {
    model,
    max_tokens: args.maxTokens ?? 700,
    temperature: 0,
    system: args.system,
    messages: [{ role: "user", content }],
  });

  const blocks = response.data?.content;
  const text = Array.isArray(blocks)
    ? blocks.map((b: { text?: string }) => b?.text ?? "").join("")
    : "";

  return {
    json: extractJson(text),
    usage: response.data?.usage
      ? {
          prompt: Number(response.data.usage.input_tokens) || 0,
          completion: Number(response.data.usage.output_tokens) || 0,
        }
      : null,
  };
}

const llmBreaker = breakerWrap<[LlmArgs], { json: Record<string, unknown> | null; usage: LlmUsage | null }>(
  "llm-claude",
  LLM_TIMEOUT_MS,
  callClaude,
);

export const callLlm = async (args: LlmArgs) => {
  try {
    return await llmBreaker.fire(args);
  } catch (err) {
    console.error("LLM call failed:", err instanceof Error ? err.message : err);
    return { json: null, usage: null };
  }
};

function extractJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
