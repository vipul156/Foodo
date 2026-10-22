"""Egress resilience primitives — pool isolation + per-dependency breakers.

One implementation for every Python service. The per-service knobs (pool
names, timeouts, connection limits, retry shape) are data in a
``ResiliencePolicy``; the machinery is here.

Mirrors the Node services' pool isolation + circuit-breaker pattern:
- One shared httpx.AsyncClient per egress pool (timeouts live on the pool)
- A per-dependency circuit breaker with a deterministic half-open probe
- Tenacity exponential backoff for transient network errors only

Breakers are in-process — good enough for one pod; a Redis/etcd-backed
breaker is the multi-pod upgrade path.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from enum import Enum
from typing import Any, Awaitable, Callable

import httpx
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

#: Transient network errors worth retrying (never 4xx).
RETRYABLE_EXCEPTIONS: tuple[type[BaseException], ...] = (
    httpx.TransportError,
    httpx.TimeoutException,
)


class BreakerOpen(Exception):
    """Raised when the circuit is open — callers must fail fast/soft."""


class BreakerState(str, Enum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"


@dataclass
class Breaker:
    """A single dependency's circuit breaker."""

    failure_threshold: int
    reset_timeout: float
    failures: int = 0
    state: BreakerState = BreakerState.CLOSED
    opened_at: float = 0.0

    def allow(self) -> bool:
        if self.state is BreakerState.OPEN:
            if time.monotonic() - self.opened_at >= self.reset_timeout:
                self.state = BreakerState.HALF_OPEN  # single probe
                return True
            return False
        return True

    def record_success(self) -> None:
        self.failures = 0
        self.state = BreakerState.CLOSED

    def record_failure(self) -> None:
        self.failures += 1
        if self.state is BreakerState.HALF_OPEN or self.failures >= self.failure_threshold:
            self.state = BreakerState.OPEN
            self.opened_at = time.monotonic()


@dataclass(frozen=True)
class PoolSpec:
    """One isolated egress pool.

    Pools exist so a slow dependency cannot starve the others: the LLM
    provider and the internal API get separate connection budgets and
    separate timeouts.
    """

    name: str
    timeout_s: float
    max_connections: int = 30
    max_keepalive_connections: int = 8


@dataclass(frozen=True)
class ResiliencePolicy:
    """Per-service knobs for the shared resilience machinery."""

    pools: tuple[PoolSpec, ...] = ()
    breaker_failure_threshold: int = 5
    breaker_reset_timeout_s: float = 15.0
    retries: int = 2  # extra attempts after the first
    retry_multiplier: float = 0.2
    retry_max_wait: float = 2.0


class BreakerRegistry:
    """Named breakers — one per downstream dependency."""

    def __init__(self, policy: ResiliencePolicy) -> None:
        self._policy = policy
        self._breakers: dict[str, Breaker] = {}

    def get(self, name: str) -> Breaker:
        if name not in self._breakers:
            self._breakers[name] = Breaker(
                failure_threshold=self._policy.breaker_failure_threshold,
                reset_timeout=self._policy.breaker_reset_timeout_s,
            )
        return self._breakers[name]


class EgressPools:
    """httpx clients — one per pool spec, isolated by dependency class."""

    def __init__(self, policy: ResiliencePolicy) -> None:
        self._clients: dict[str, httpx.AsyncClient] = {
            spec.name: httpx.AsyncClient(
                timeout=httpx.Timeout(spec.timeout_s),
                limits=httpx.Limits(
                    max_connections=spec.max_connections,
                    max_keepalive_connections=spec.max_keepalive_connections,
                ),
            )
            for spec in policy.pools
        }

    def __getattr__(self, item: str) -> httpx.AsyncClient:
        try:
            return self._clients[item]
        except KeyError:
            raise AttributeError(
                f"no egress pool named {item!r} "
                f"(configured: {sorted(self._clients)})"
            ) from None

    async def aclose(self) -> None:
        for client in self._clients.values():
            await client.aclose()


class Resilience:
    """Configured facade over the pools + breakers (one per service)."""

    def __init__(self, policy: ResiliencePolicy) -> None:
        self.policy = policy
        self.breakers = BreakerRegistry(policy)
        self.pools = EgressPools(policy)

    async def call_with_resilience(
        self,
        breaker_name: str,
        fn: Callable[[], Awaitable[Any]],
        *,
        retries: int | None = None,
    ) -> Any:
        """breaker → retry → call. Open circuit fails fast with BreakerOpen."""
        attempts = self.policy.retries if retries is None else retries
        breaker = self.breakers.get(breaker_name)
        if not breaker.allow():
            raise BreakerOpen(f"{breaker_name} circuit open")

        @retry(
            retry=retry_if_exception_type(RETRYABLE_EXCEPTIONS),
            stop=stop_after_attempt(max(1, attempts + 1)),
            wait=wait_exponential(
                multiplier=self.policy.retry_multiplier,
                max=self.policy.retry_max_wait,
            ),
            reraise=True,
        )
        async def _invoke() -> Any:
            return await fn()

        try:
            result = await _invoke()
        except Exception:
            breaker.record_failure()
            raise
        else:
            breaker.record_success()
            return result

    async def request(
        self,
        method: str,
        url: str,
        *,
        pool: str = "internal",
        params: dict | None = None,
        json_body: Any = None,
        headers: dict | None = None,
        breaker: str | None = None,
        retries: int | None = None,
    ) -> Any:
        """One pooled, breaker-wrapped HTTP call returning the JSON body."""
        client = getattr(self.pools, pool)

        async def _do() -> Any:
            response = await client.request(
                method,
                url,
                params=params,
                json=json_body,
                headers=headers,
            )
            response.raise_for_status()
            return response.json()

        return await self.call_with_resilience(
            breaker or f"{pool}-{method.lower()}", _do, retries=retries
        )

    async def internal_get(
        self,
        url: str,
        *,
        params: dict | None = None,
        headers: dict | None = None,
        breaker: str | None = None,
        retries: int | None = None,
    ) -> Any:
        return await self.request(
            "GET", url, pool="internal", params=params, headers=headers,
            breaker=breaker, retries=retries,
        )

    async def internal_post(
        self,
        url: str,
        *,
        json_body: Any = None,
        headers: dict | None = None,
        breaker: str | None = None,
        retries: int | None = None,
    ) -> Any:
        return await self.request(
            "POST", url, pool="internal", json_body=json_body, headers=headers,
            breaker=breaker, retries=retries,
        )

    async def internal_put(
        self,
        url: str,
        *,
        json_body: Any = None,
        headers: dict | None = None,
        breaker: str | None = None,
        retries: int | None = None,
    ) -> Any:
        return await self.request(
            "PUT", url, pool="internal", json_body=json_body, headers=headers,
            breaker=breaker, retries=retries,
        )
