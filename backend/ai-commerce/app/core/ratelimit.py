"""Rate limiting — shared DynamoDB counters via pycommon.

Same posture as the Node services: per-identity limits on expensive
endpoints (each turn can cost multiple LLM + HTTP round trips). The
in-memory deque would give every warm Lambda container its own counter,
making "15/min" really "15/min per container" — the shared counter is
what makes the limit real. The limiter FAILS OPEN (see pycommon), so an
outage never bricks the conversational surface.
"""

from __future__ import annotations

from pycommon.ratelimit import enforce_rate_limit as _enforce

from app.core.config import get_settings

settings = get_settings()


async def enforce_rate_limit(key: str, limit: int | None = None) -> None:
    """Fixed 60s window; raises 429 when the shared counter is over cap."""
    _enforce(
        key,
        limit or settings.rate_limit_turns,
        prefix="commerce",
        message="Too many requests — slow down",
    )
