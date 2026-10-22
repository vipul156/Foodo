"""Egress resilience for ai-dispatch — the shared core plus this service's policy.

The primitives (pools, breakers, retries) live in ``pycommon.resilience``;
only ai-dispatch's policy is local: which egress pools exist, their
timeouts and connection budgets, and the retry shape.
"""

from __future__ import annotations

from pycommon.resilience import (  # noqa: F401 (re-exported for callers)
    BreakerOpen,
    PoolSpec,
    Resilience,
    ResiliencePolicy,
)

from app.core.config import get_settings

settings = get_settings()

#: Isolate egress by dependency class: internal services vs. the external
#: weather API. A hanging weather call must never starve the internal pool.
POLICY = ResiliencePolicy(
    pools=(
        PoolSpec(
            "internal",
            settings.internal_timeout_s,
            max_connections=30,
            max_keepalive_connections=8,
        ),
        PoolSpec(
            "weather",
            settings.weather_timeout_s,
            max_connections=10,
            max_keepalive_connections=4,
        ),
    ),
    breaker_failure_threshold=settings.breaker_failure_threshold,
    breaker_reset_timeout_s=settings.breaker_reset_timeout_s,
)

resilience = Resilience(POLICY)

pools = resilience.pools
breakers = resilience.breakers

call_with_resilience = resilience.call_with_resilience
internal_get = resilience.internal_get
internal_post = resilience.internal_post
internal_put = resilience.internal_put
