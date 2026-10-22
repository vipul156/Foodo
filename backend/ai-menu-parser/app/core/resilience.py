"""Egress resilience for ai-menu-parser — the shared core plus this service's policy.

The primitives (pools, breakers, retries) live in ``pycommon.resilience``;
only ai-menu-parser's policy is local: which egress pools exist, their
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

#: Isolate egress by dependency class: the Gemini vision API vs. internal
#: services. A slow vision call must never starve the internal pool.
POLICY = ResiliencePolicy(
    pools=(
        PoolSpec(
            "gemini",
            settings.gemini_timeout_s,
            max_connections=10,
            max_keepalive_connections=4,
        ),
        PoolSpec(
            "internal",
            settings.internal_timeout_s,
            max_connections=30,
            max_keepalive_connections=8,
        ),
    ),
    breaker_failure_threshold=settings.breaker_failure_threshold,
    breaker_reset_timeout_s=settings.breaker_reset_timeout_s,
    retries=1,
    retry_multiplier=0.5,
    retry_max_wait=4.0,
)

resilience = Resilience(POLICY)

pools = resilience.pools
breakers = resilience.breakers

call_with_resilience = resilience.call_with_resilience
internal_get = resilience.internal_get
internal_post = resilience.internal_post
internal_put = resilience.internal_put
