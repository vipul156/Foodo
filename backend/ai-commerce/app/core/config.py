"""Typed, validated settings — the single source of truth for configuration.

Every knob is an environment variable with a sensible default; nothing is
hardcoded elsewhere in the codebase. Startup fails fast on misconfiguration
via required-field validation instead of an env crash at request time.

The shared shape (identity-plane secrets, resilience defaults, fail-fast
posture) lives in ``pycommon.config``; this file is only what is specific
to ai-commerce.
"""

from __future__ import annotations

from pydantic import Field, field_validator

from pycommon.config import BaseServiceSettings, cached_settings


class Settings(BaseServiceSettings):
    # ─── Service identity ────────────────────────────────────────
    app_name: str = "ai-commerce"
    port: int = 3009

    # ─── Sibling services (REST, internal-key protected) ─────────
    auth_service_url: str = "http://localhost:3001"
    restaurant_service_url: str = "http://localhost:3003"
    utils_service_url: str = "http://localhost:3005"

    # ─── LLM provider (LangChain) ────────────────────────────────
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-haiku-4-5"
    llm_timeout_s: float = 30.0
    llm_max_tokens: int = 1024

    # ─── Conversational session bounds ───────────────────────────
    session_ttl_min: int = 60          # DynamoDB TTL on draft sessions
    session_max_turns: int = 30        # hard stop per conversation
    history_window: int = 12           # messages fed back to the model

    # ─── Guardrails ──────────────────────────────────────────────
    max_units_per_item: int = Field(default=20, ge=1, le=100)
    max_cart_value: float = 10_000.0   # absolute clamp on draft totals
    max_menu_candidates: int = 5
    semantic_match_threshold: float = 0.35  # min cosine similarity

    # ─── Resilience ──────────────────────────────────────────────
    max_graph_steps: int = 40  # LangGraph recursion bound per user turn

    # ─── Rate limiting (per user, per minute) ────────────────────
    rate_limit_turns: int = 15

    @field_validator("jwt_secret", "cookie_secret")
    @classmethod
    def _require_identity_secrets(cls, v: str, info) -> str:  # type: ignore[no-untyped-def]
        if not v:
            label = {
                "jwt_secret": "JWT_SECRET",
                "cookie_secret": "COOKIE_SECRET",
            }.get(info.field_name, info.field_name)
            raise ValueError(f"{label} must be set — fail-closed without it")
        return v


get_settings = cached_settings(Settings)
