"""Rate limiting — Redis fixed-window when available, in-process otherwise.

Same posture as the Node services: per-identity limits on expensive
endpoints (each turn can cost multiple LLM + HTTP round trips).
"""

from __future__ import annotations

import time
from collections import defaultdict, deque

from fastapi import HTTPException, status

from app.core.config import get_settings
from app.services.db import database

settings = get_settings()

_memory_hits: dict[str, deque[float]] = defaultdict(deque)


async def enforce_rate_limit(key: str, limit: int | None = None) -> None:
    """Sliding/fixed 60s window. Raises 429 when exceeded."""
    cap = limit or settings.rate_limit_turns
    window_s = 60
    now = time.time()

    if database.redis is not None:
        redis_key = f"rl:{key}:{int(now // window_s)}"
        count = await database.redis.incr(redis_key)
        if count == 1:
            await database.redis.expire(redis_key, window_s + 1)
        if count > cap:
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                "Too many requests — slow down",
            )
        return

    # In-process fallback (single pod)
    hits = _memory_hits[key]
    while hits and now - hits[0] > window_s:
        hits.popleft()
    if len(hits) >= cap:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Too many requests — slow down",
        )
    hits.append(now)
