"""OpenAI-compatible chat-model factory — one client, any vendor.

Every provider Foodo supports speaks the OpenAI Chat Completions wire
format, so a single ``ChatOpenAI`` client plus a different ``base_url`` is
the entire difference between them:

  * built-in endpoints — openai, groq, openrouter, together, fireworks,
    deepseek, ollama, lmstudio (see the table below)
  * anything else — vllm, tgi, a self-hosted gateway — needs LLM_BASE_URL

Selection is env-only (``LLM_PROVIDER`` / ``LLM_MODEL`` / ``LLM_API_KEY`` /
``LLM_BASE_URL``), so swapping vendors is a deploy-time decision, never a
code change. Anthropic is deliberately not wired here: its native
message/tool schema differs from OpenAI's and no service calls it.

LangChain imports are deliberately lazy: pycommon is vendored into services
that never build a chat model (ai-menu-parser posts to the endpoint over
raw HTTP), and importing their package must not require langchain.

Caveat worth knowing before switching: ``max_tokens`` is honoured by the
servers above, but OpenAI's own o-series / gpt-5 models want
``max_completion_tokens`` and will reject it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# Providers speaking the OpenAI Chat Completions wire format, with their
# default base URL. Anything else (including "openai-compatible", "vllm",
# "custom") works too — it just needs an explicit LLM_BASE_URL.
OPENAI_COMPATIBLE_BASE_URLS: dict[str, str] = {
    "openai": "https://api.openai.com/v1",
    "groq": "https://api.groq.com/openai/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "together": "https://api.together.xyz/v1",
    "fireworks": "https://api.fireworks.ai/inference/v1",
    "deepseek": "https://api.deepseek.com/v1",
    "ollama": "http://localhost:11434/v1",
    "lmstudio": "http://localhost:1234/v1",
}

# Local runtimes do not authenticate; the OpenAI SDK still demands a string.
_KEYLESS_PROVIDERS = frozenset({"ollama", "lmstudio"})


class LlmConfigError(RuntimeError):
    """The selected provider lacks the config needed to build a client."""


@dataclass(frozen=True)
class LlmSettings:
    """Resolved provider config: one vendor, one model, one key."""

    provider: str = "openai"
    model: str = ""
    api_key: str = ""
    base_url: str = ""
    temperature: float = 0.0
    max_tokens: int = 1024
    timeout_s: float = 30.0

    @classmethod
    def resolve(
        cls,
        *,
        provider: str,
        model: str,
        api_key: str,
        base_url: str = "",
        temperature: float = 0.0,
        max_tokens: int = 1024,
        timeout_s: float = 30.0,
    ) -> "LlmSettings":
        """Normalize the env values into a resolved settings object.

        There is no per-vendor model default on purpose: a stale default
        would silently send the wrong model id to whichever endpoint
        LLM_PROVIDER points at.
        """
        return cls(
            provider=(provider or "openai").strip().lower(),
            model=(model or "").strip(),
            api_key=(api_key or "").strip(),
            base_url=(base_url or "").strip(),
            temperature=temperature,
            max_tokens=max_tokens,
            timeout_s=timeout_s,
        )

    @property
    def endpoint(self) -> str:
        """Effective base URL — an explicit override wins over the preset."""
        if self.base_url:
            return self.base_url.rstrip("/")
        return OPENAI_COMPATIBLE_BASE_URLS.get(self.provider, "")

    @property
    def is_configured(self) -> bool:
        """True when a call could plausibly succeed (model + key + URL).

        Services use this to keep their deterministic fallback path instead
        of raising: an unconfigured LLM must degrade the feature, never take
        the route down.
        """
        if not self.model or not self.endpoint:
            return False
        if self.provider in _KEYLESS_PROVIDERS:
            return True
        return bool(self.api_key)


def build_chat_model(cfg: LlmSettings) -> Any:
    """Build the chat model ``cfg`` describes.

    The return value is a LangChain ``BaseChatModel`` (``bind_tools`` and
    ``ainvoke`` are both available). It stays typed as ``Any`` so this
    module never imports langchain at module scope.

    Raises :class:`LlmConfigError` when the provider is not configured.
    """
    if not cfg.is_configured:
        raise LlmConfigError(_misconfig_message(cfg))

    from langchain_openai import ChatOpenAI

    return ChatOpenAI(
        model=cfg.model,
        api_key=cfg.api_key or "not-needed",  # local servers ignore it
        base_url=cfg.endpoint,
        temperature=cfg.temperature,
        max_tokens=cfg.max_tokens,
        timeout=cfg.timeout_s,
    )


def _misconfig_message(cfg: LlmSettings) -> str:
    """Name the exact env var that is missing — never a bare traceback."""
    missing = [
        label
        for label, ok in (
            ("LLM_MODEL", bool(cfg.model)),
            ("LLM_API_KEY", cfg.provider in _KEYLESS_PROVIDERS or bool(cfg.api_key)),
            ("LLM_BASE_URL", bool(cfg.endpoint)),
        )
        if not ok
    ]
    known = ", ".join(sorted(OPENAI_COMPATIBLE_BASE_URLS))
    return (
        f"LLM_PROVIDER={cfg.provider!r} is missing {', '.join(missing)} "
        f"(providers with a built-in endpoint: {known})"
    )
