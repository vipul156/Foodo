"""DynamoDB fixed-window rate limiter — the analog of TS createDynamoRateLimitStore.

The platform deliberately has no Redis: an in-process deque gives every
warm Lambda container its OWN counter, so a "5/min" limit is really
"5/min per container". Counters live in the shared rate-limits table
(one row per prefix+key+window) with a TTL that lets the table self-clean.

Atomicity: DynamoDB ``SET x = if_not_exists(x, :zero) + :one`` is atomic
per attribute, so concurrent containers bump the same counter — the cap
is platform-wide, not per-container.

Failure posture mirrors the TS store: it FAILS OPEN. A limiter outage
must never take the seller or rider flow down; the gateway authorizer
and the in-app internal-key/session gates are the real access controls.
"""

from __future__ import annotations

import time

from fastapi import HTTPException, status

from pycommon.aws import table

_TABLE = ("RATE_LIMITS_TABLE", "foodo-rate-limits")


def consume(key: str, limit: int, *, window_s: int = 60, prefix: str = "generic") -> bool:
    """Take one hit against ``limit`` per ``window_s`` for ``key``.

    Returns True when allowed, False when the caller should get a 429.
    The row key embeds the wall-clock window id, so a new window starts
    a fresh counter and the previous row's TTL sweeps it away.
    """
    try:
        now = int(time.time())
        window_id = now // window_s
        expires_at = (window_id + 1) * window_s + 1  # sweep after the window

        response = table(*_TABLE).update_item(
            Key={"pk": f"RL#{prefix}#{key}#{window_id}"},
            UpdateExpression=(
                "SET #c = if_not_exists(#c, :zero) + :one, #ttl = :expires, #w = :window"
            ),
            ExpressionAttributeNames={"#c": "count", "#ttl": "ttl", "#w": "windowId"},
            ExpressionAttributeValues={
                ":zero": 0,
                ":one": 1,
                ":expires": expires_at,
                ":window": window_id,
            },
            ReturnValues="ALL_NEW",
        )
        count = int((response.get("Attributes") or {}).get("count", 0))
        return count <= limit
    except Exception as exc:  # noqa: BLE001 — fail open, never brick the flow
        print(f"[pycommon] rate limiter failed open ({prefix}:{key}): {exc}")
        return True


def enforce_rate_limit(
    key: str,
    limit: int,
    *,
    window_s: int = 60,
    prefix: str = "generic",
    message: str = "Too many requests — slow down",
) -> None:
    """Take one hit against ``limit``; raise 429 when the caller is over cap.

    The counter is shared across warm containers, so the cap is
    platform-wide rather than per-container.
    """
    if not consume(key, limit, window_s=window_s, prefix=prefix):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, message)
