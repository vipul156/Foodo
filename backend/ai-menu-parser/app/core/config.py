"""Typed, fail-fast configuration for the AI menu parser.

The shared shape (identity-plane secrets, resilience defaults, fail-fast
posture) lives in ``pycommon.config``; this file is only what is specific
to the menu parser.
"""

from __future__ import annotations

from pydantic import Field, field_validator

from pycommon.config import BaseServiceSettings, cached_settings


class Settings(BaseServiceSettings):
    # ─── Service identity ────────────────────────────────────────
    app_name: str = "ai-menu-parser"
    port: int = 3011

    # ─── Sibling services ────────────────────────────────────────
    restaurant_service_url: str = "http://localhost:3003"

    # ─── Vision provider (Gemini, structured JSON mode) ──────────
    gemini_api_key: str = ""
    gemini_model: str = "gemini-2.5-flash"
    gemini_timeout_s: float = 45.0
    gemini_max_output_tokens: int = 8192

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

    @field_validator("gemini_api_key")
    @classmethod
    def _require_gemini_key(cls, v: str) -> str:
        if not v:
            raise ValueError("GEMINI_API_KEY must be set — fail-closed without it")
        return v


get_settings = cached_settings(Settings)
