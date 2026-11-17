"""Typed, fail-fast configuration for the AI menu parser.

The shared shape (identity-plane secrets, resilience defaults, fail-fast
posture) lives in ``pycommon.config``; this file is only what is specific
to the menu parser.
"""

from __future__ import annotations

from pydantic import Field, model_validator

from pycommon.config import BaseServiceSettings, cached_settings
from pycommon.llm import LlmSettings


class Settings(BaseServiceSettings):
    # ─── Service identity ────────────────────────────────────────
    app_name: str = "ai-menu-parser"
    port: int = 3011

    # ─── Sibling services ────────────────────────────────────────
    restaurant_service_url: str = "http://localhost:3003"

    # ─── Vision model (OpenAI-compatible, structured JSON mode) ──
    llm_provider: str = "openai"
    llm_model: str = ""
    llm_api_key: str = ""
    llm_base_url: str = ""
    llm_timeout_s: float = 45.0
    llm_max_output_tokens: int = 8192

    # ─── Parse bounds (DoS + cost caps) ──────────────────────────
    max_categories: int = Field(default=20, ge=1, le=50)
    max_items_per_category: int = Field(default=40, ge=1, le=100)
    max_menu_items: int = Field(default=150, ge=1, le=300)
    max_price: float = Field(default=100_000.0, gt=0)
    max_image_bytes: int = 10 * 1024 * 1024
    max_bulk_items: int = 300  # per bulk-publish call

    # ─── Resilience ──────────────────────────────────────────────
    breaker_reset_timeout_s: float = 30.0
    rate_limit_parse_per_min: int = 5  # per seller — vision calls cost money

    @property
    def llm(self) -> LlmSettings:
        """Resolved provider config — endpoint, key and model in one place."""
        return LlmSettings.resolve(
            provider=self.llm_provider,
            model=self.llm_model,
            api_key=self.llm_api_key,
            base_url=self.llm_base_url,
            max_tokens=self.llm_max_output_tokens,
            timeout_s=self.llm_timeout_s,
        )

    @model_validator(mode="after")
    def _require_vision_model(self) -> "Settings":
        # Fail-closed: a parser with no model would 502 on every photo.
        if not self.llm.is_configured:
            raise ValueError(
                f"vision model not configured (LLM_PROVIDER={self.llm_provider!r}): "
                "set LLM_MODEL and LLM_API_KEY, or LLM_BASE_URL for a "
                "self-hosted OpenAI-compatible server"
            )
        return self


get_settings = cached_settings(Settings)
