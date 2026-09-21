"""Resilience primitives — isolated pools + per-dependency breakers.

Same pattern as ai-commerce: one httpx pool per dependency class, a
deterministic half-open breaker per dependency, tenacity retries for
transient network errors only.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Awaitable, Callable

import httpx
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from app.core.config import get_settings
from app.core.logging import get_logger

log = get_logger(__name__)
settings = get_settings()


class BreakerOpen(Exception):
    pass


class _State(str, Enum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"


@dataclass
class _Breaker:
    failure_threshold: int
    reset_timeout: float
    failures: int = 0
    state: _State = _State.CLOSED
    opened_at: float = 0.0

    def allow(self) -> bool:
        if self.state is _State.OPEN:
            if time.monotonic() - self.opened_at >= self.reset_timeout:
                self.state = _State.HALF_OPEN  # single probe
                return True
            return False
        return True

    def record_success(self) -> None:
        self.failures = 0
        self.state = _State.CLOSED

    def record_failure(self) -> None:
        self.failures += 1
        if self.state is _State.HALF_OPEN or self.failures >= self.failure_threshold:
            self.state = _State.OPEN
            self.opened_at = time.monotonic()


class BreakerRegistry:
    def __init__(self) -> None:
        self._breakers: dict[str, _Breaker] = {}

    def get(self, name: str) -> _Breaker:
        if name not in self._breakers:
            self._breakers[name] = _Breaker(
                failure_threshold=settings.breaker_failure_threshold,
                reset_timeout=settings.breaker_reset_timeout_s,
            )
        return self._breakers[name]


breakers = BreakerRegistry()

_RETRYABLE = (httpx.TransportError, httpx.TimeoutException)


@dataclass
class Pools:
    """Isolated egress pools — internal services vs. external weather API."""

    internal: httpx.AsyncClient = field(init=False)
    weather: httpx.AsyncClient = field(init=False)

    def __post_init__(self) -> None:
        self.internal = httpx.AsyncClient(
            timeout=httpx.Timeout(settings.internal_timeout_s),
            limits=httpx.Limits(max_connections=30, max_keepalive_connections=8),
        )
        self.weather = httpx.AsyncClient(
            timeout=httpx.Timeout(6.0),
            limits=httpx.Limits(max_connections=10, max_keepalive_connections=4),
        )

    async def aclose(self) -> None:
        await self.internal.aclose()
        await self.weather.aclose()


pools = Pools()


async def call_with_resilience(
    breaker_name: str,
    fn: Callable[[], Awaitable[Any]],
    *,
    retries: int = 2,
) -> Any:
    """breaker → retry → call. Open circuit fails fast with BreakerOpen."""
    breaker = breakers.get(breaker_name)
    if not breaker.allow():
        raise BreakerOpen(f"{breaker_name} circuit open")

    @retry(
        retry=retry_if_exception_type(_RETRYABLE),
        stop=stop_after_attempt(max(1, retries + 1)),
        wait=wait_exponential(multiplier=0.2, max=2),
        reraise=True,
    )
    async def _invoke() -> Any:
        return await fn()

    try:
        result = await _invoke()
    except _RETRYABLE:
        breaker.record_failure()
        raise
    except Exception:
        breaker.record_failure()
        raise
    else:
        breaker.record_success()
        return result


async def internal_get(url: str, *, params: dict | None = None, headers: dict | None = None) -> Any:
    async def _do() -> Any:
        response = await pools.internal.get(url, params=params, headers=headers)
        response.raise_for_status()
        return response.json()

    return await call_with_resilience("internal-get", _do)


async def internal_post(url: str, *, json_body: Any = None, headers: dict | None = None) -> Any:
    async def _do() -> Any:
        response = await pools.internal.post(url, json=json_body, headers=headers)
        response.raise_for_status()
        return response.json()

    return await call_with_resilience("internal-post", _do)
