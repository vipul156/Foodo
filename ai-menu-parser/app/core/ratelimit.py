"""Rate limiting — in-process fixed window.

Vision parsing costs real money per call; the per-seller limit is
deliberately tight. Redis-backed multi-pod limiting is the upgrade path
(same interface as ai-commerce's ratelimit).
"""

from __future__ import annotations

import time
from collections import defaultdict, deque

from fastapi import HTTPException, status

_memory_hits: dict[str, deque[float]] = defaultdict(deque)


async def enforce_rate_limit(key: str, limit: int, window_s: int = 60) -> None:
    now = time.time()
    hits = _memory_hits[key]
    while hits and now - hits[0] > window_s:
        hits.popleft()
    if len(hits) >= limit:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Too many parse requests — please wait a minute",
        )
    hits.append(now)
