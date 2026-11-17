// @foodo/backend-common/llm — OpenAI-compatible LLM plumbing.
//
// Every model Foodo calls speaks the OpenAI Chat Completions wire format,
// so one request shape plus a different base URL covers OpenAI, Groq,
// OpenRouter, Together, Fireworks, DeepSeek, Ollama, LM Studio and any
// vLLM/TGI gateway.
//
// This module is transport-free on purpose: it resolves env, builds the
// payload and parses the response. Each service keeps ownership of its
// own HTTP client, timeout and circuit breaker, so the AI tier's egress
// isolation rules stay where they were.

const PRESET_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  together: "https://api.together.xyz/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  deepseek: "https://api.deepseek.com/v1",
  ollama: "http://localhost:11434/v1",
  lmstudio: "http://localhost:1234/v1",
};

// Local runtimes do not authenticate; the SDK/API still wants a value.
const KEYLESS_PROVIDERS = new Set(["ollama", "lmstudio"]);

export interface LlmConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
}

export interface ChatJsonArgs {
  system: string;
  userText: string;
  imageBase64?: string | null;
  imageMimeType?: string;
  maxTokens?: number;
}

export interface LlmUsage {
  prompt: number;
  completion: number;
}

export interface ChatJsonResult {
  json: Record<string, unknown> | null;
  usage: LlmUsage | null;
}

/**
 * Resolve the provider from the environment.
 *
 * Returns null when the deployment has no usable endpoint, so callers can
 * degrade (unverified / deterministic) instead of throwing — same posture
 * as a provider timeout, never a 5xx on the request path.
 */
export function resolveLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig | null {
  const provider = (env.LLM_PROVIDER || "openai").trim().toLowerCase();
  const model = (env.LLM_MODEL || "").trim();
  const apiKey = (env.LLM_API_KEY || "").trim();
  const explicitBaseUrl = (env.LLM_BASE_URL || "").trim().replace(/\/+$/, "");
  const baseUrl = explicitBaseUrl || PRESET_BASE_URLS[provider] || "";

  if (!model || !baseUrl) return null;
  if (!apiKey && !KEYLESS_PROVIDERS.has(provider)) return null;

  return { provider, model, apiKey: apiKey || "not-needed", baseUrl };
}

export const chatCompletionsUrl = (cfg: LlmConfig): string =>
  `${cfg.baseUrl}/chat/completions`;

export const authHeaders = (cfg: LlmConfig): Record<string, string> => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.apiKey !== "not-needed") headers.authorization = `Bearer ${cfg.apiKey}`;
  return headers;
};

/**
 * Chat Completions payload that asks for a JSON object.
 *
 * `response_format: json_object` is the lowest common denominator across
 * the compatible servers. It still needs the word "JSON" somewhere in the
 * prompt, and it is a hint rather than a schema — callers must keep
 * parsing defensively.
 *
 * `max_tokens` is honoured by all the servers above except OpenAI's own
 * o-series / gpt-5 models, which want `max_completion_tokens`.
 */
export function buildChatJsonPayload(
  cfg: LlmConfig,
  args: ChatJsonArgs,
): Record<string, unknown> {
  const userContent = args.imageBase64
    ? [
        {
          type: "image_url",
          image_url: {
            url: `data:${args.imageMimeType ?? "image/jpeg"};base64,${args.imageBase64}`,
          },
        },
        { type: "text", text: args.userText },
      ]
    : args.userText;

  return {
    model: cfg.model,
    temperature: 0,
    max_tokens: args.maxTokens ?? 700,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: args.system },
      { role: "user", content: userContent },
    ],
  };
}

/** Parse `choices[0].message.content` defensively — never throws. */
export function extractChatJson(data: unknown): ChatJsonResult {
  const payload = data as
    | {
        choices?: { message?: { content?: unknown } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      }
    | null
    | undefined;

  const content = payload?.choices?.[0]?.message?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => (part as { text?: string })?.text ?? "").join("")
        : "";

  const usage = payload?.usage
    ? {
        prompt: Number(payload.usage.prompt_tokens) || 0,
        completion: Number(payload.usage.completion_tokens) || 0,
      }
    : null;

  return { json: extractJson(text), usage };
}

function extractJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  // Strip markdown fences and surrounding prose
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(candidate.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
