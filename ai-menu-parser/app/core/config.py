"""Typed, fail-fast configuration for the AI menu parser."""

from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # ─── Service identity ────────────────────────────────────────
    app_name: str = "ai-menu-parser"
    port: int = 3011
    environment: str = "development"
    log_level: str = "INFO"
    frontend_url: str = "http://localhost:3000"

    # ─── Sibling services ────────────────────────────────────────
    internal_service_key: str = ""
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
    breaker_failure_threshold: int = 5
    breaker_reset_timeout_s: float = 30.0
    internal_timeout_s: float = 5.0
    rate_limit_parse_per_min: int = 5  # per seller — vision calls cost money

    @field_validator("internal_service_key", "gemini_api_key")
    @classmethod
    def _require_secrets(cls, v: str, info) -> str:  # type: ignore[no-untyped-def]
        if not v:
            label = {
                "internal_service_key": "INTERNAL_SERVICE_KEY",
                "gemini_api_key": "GEMINI_API_KEY",
            }.get(info.field_name, info.field_name)
            raise ValueError(f"{label} must be set — fail-closed without it")
        return v

    @property
    def is_prod(self) -> bool:
        return self.environment == "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
