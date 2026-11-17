"""Rate limiting — shared DynamoDB counters via pycommon.

Vision parsing costs real money per call; the per-seller limit is
deliberately tight. The in-process deque would give every warm Lambda
container its own counter, so "5/min" would really be "5/min per
container" — the shared counter makes the cap platform-wide. The limiter
FAILS OPEN on an outage (pycommon), so a counting problem never bricks
the seller's import flow.
"""

from __future__ import annotations

from pycommon.ratelimit import enforce_rate_limit as _enforce


async def enforce_rate_limit(key: str, limit: int, window_s: int = 60) -> None:
    _enforce(
        key,
        limit,
        window_s=window_s,
        prefix="menu-parser",
        message="Too many parse requests — please wait a minute",
    )
