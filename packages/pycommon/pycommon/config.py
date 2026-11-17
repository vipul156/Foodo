"""Base settings — the shape every Foodo Python service's config shares.

Each service subclasses :class:`BaseServiceSettings` and adds only its own
knobs. The shared identity-plane secrets, the fail-fast posture and the
resilience defaults live here so they cannot drift apart between services.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Callable, TypeVar

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

S = TypeVar("S", bound="BaseServiceSettings")


class BaseServiceSettings(BaseSettings):
    """Fields, defaults and validation every Python service shares.

    Every knob is an environment variable with a sensible default; nothing
    is hardcoded elsewhere in the codebase. Startup fails fast on
    misconfiguration via required-field validation instead of an env crash
    at request time.
    """

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # ─── Service identity ────────────────────────────────────────
    app_name: str = "foodo-service"
    port: int = 0
    environment: str = "development"
    log_level: str = "INFO"
    frontend_url: str = "http://localhost:3000"

    # ─── Identity plane (mirrors the Node services) ──────────────
    jwt_secret: str = ""
    cookie_secret: str = ""

    # ─── Sibling services (internal-key protected) ───────────────
    internal_service_key: str = ""

    # ─── Resilience (shared defaults — see pycommon.resilience) ─
    breaker_failure_threshold: int = 5
    breaker_reset_timeout_s: float = 15.0
    internal_timeout_s: float = 5.0

    @field_validator("internal_service_key")
    @classmethod
    def _require_internal_key(cls, v: str) -> str:
        if not v:
            raise ValueError(
                "INTERNAL_SERVICE_KEY must be set — cross-service calls are fail-closed"
            )
        return v

    @property
    def is_prod(self) -> bool:
        return self.environment == "production"


def cached_settings(cls: type[S]) -> Callable[[], S]:
    """Return an lru-cached zero-arg factory for a settings class.

    Settings are built once per warm container and reused, so a misconfigured
    environment fails at import time rather than on the first request.
    """

    @lru_cache
    def _get_settings() -> S:
        return cls()

    return _get_settings
