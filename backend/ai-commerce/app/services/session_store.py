"""Conversation + draft-order session store (DynamoDB).

Replaces the Mongo (Motor) collection with one item per session:

  PK: SESSION#<userId>      SK: SESSION#<sessionId>
  GSI user-index: userId → updatedAt (newest-first session list)

The draft state IS the source of truth for the checkout card; the LLM
reads snapshots, never mutates it directly (mutations flow through the
mutator, which re-prices). Abandoned drafts self-clean via the item TTL
(DynamoDB TTL sweep replaces the Mongo expireAfterSeconds index).
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any

from pycommon.aws import from_dynamo, table, to_dynamo
from pycommon.logging import get_logger

from app.core.config import get_settings
from app.schemas.commerce import DraftOrderState

log = get_logger(__name__)
settings = get_settings()

_SESSIONS_TABLE = ("COMMERCE_SESSIONS_TABLE", "foodo-commerce-sessions")


def _sessions():
    return table(*_SESSIONS_TABLE)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class SessionStore:
    """Same interface the Mongo implementation exposed — orchestrator
    and routes never knew which store was behind it."""

    def __init__(self) -> None:
        self._ready = False

    def _ttl(self) -> int:
        return int(time.time()) + settings.session_ttl_min * 60

    async def ensure_indexes(self) -> None:
        """Legacy no-op — DynamoDB indexes/tables are provisioned by IaC."""

    async def create(self, user_id: str) -> dict[str, Any]:
        now = _now_iso()
        session_id = f"c{int(time.time() * 1000)}-{user_id[:8]}"
        doc = {
            # The key attributes — without them the PutItem is rejected
            # ("Missing the key pk"), so no session could ever be
            # created and every new conversation would fail.
            "pk": f"SESSION#{user_id}",
            "sk": f"SESSION#{session_id}",
            "user_id": user_id,
            "session_id": session_id,
            "draft": DraftOrderState(session_id=session_id).model_dump(mode="json"),
            "history": [],
            "scratch": {"draft": DraftOrderState(session_id=session_id).model_dump(mode="json")},
            "createdAt": now,
            "updatedAt": now,
            "userId": user_id,
            "sessionId": session_id,
            "expiresAt": self._ttl(),
        }
        # The draft carries prices (floats) — DynamoDB has no float type,
        # so the cast is mandatory, not cosmetic.
        _sessions().put_item(Item=to_dynamo(doc))
        return doc

    async def get(self, user_id: str, session_id: str) -> dict[str, Any] | None:
        item = (
            _sessions()
            .get_item(Key={"pk": f"SESSION#{user_id}", "sk": f"SESSION#{session_id}"})
            .get("Item")
        )
        # Numbers come back as Decimal; the API contract wants floats
        # (a Decimal serializes to a JSON STRING).
        return from_dynamo(item) if item else None

    async def save(
        self,
        user_id: str,
        session_id: str,
        *,
        draft: dict[str, Any],
        history: list[dict[str, str]],
        scratch: dict[str, Any],
    ) -> None:
        now = _now_iso()
        _sessions().update_item(
            Key={"pk": f"SESSION#{user_id}", "sk": f"SESSION#{session_id}"},
            UpdateExpression=(
                "SET draft = :d, scratch = :s, #h = :h, updated_at = :u, "
                "#ua = :u, expiresAt = :e, #ts = :ts"
            ),
            ExpressionAttributeNames={
                "#h": "history",
                "#ua": "updatedAt",
                "#ts": "userUpdatedAt",
            },
            ExpressionAttributeValues={
                # The draft carries prices (floats) — DynamoDB has no
                # float type, so the cast is mandatory, not cosmetic.
                ":d": to_dynamo(draft),
                ":s": to_dynamo(scratch),
                ":h": history[-settings.history_window * 2 :],
                ":u": now,
                ":e": self._ttl(),
                ":ts": int(time.time() * 1000),
            },
        )

    async def list_for_user(self, user_id: str, limit: int = 10) -> list[dict[str, Any]]:
        out = _sessions().query(
            IndexName="user-index",
            KeyConditionExpression="userId = :u",
            ExpressionAttributeValues={":u": user_id},
            ScanIndexForward=False,  # newest first
            Limit=limit,
        )
        return (_to_doc(from_dynamo(item)) for item in out.get("Items", []))

    async def delete(self, user_id: str, session_id: str) -> int:
        existing = await self.get(user_id, session_id)
        if not existing:
            return 0
        _sessions().delete_item(
            Key={"pk": f"SESSION#{user_id}", "sk": f"SESSION#{session_id}"}
        )
        return 1


def _to_doc(item: dict[str, Any]) -> dict[str, Any]:
    """Shape rows like the old Mongo docs — routes read `session_id` and
    `updated_at` snake_case keys directly."""
    return {
        "session_id": item.get("session_id") or item.get("sessionId") or "",
        "user_id": item.get("user_id") or item.get("userId") or "",
        "draft": item.get("draft") or {"lines": []},
        "scratch": item.get("scratch") or {},
        "history": item.get("history") or [],
        "updated_at": item.get("updated_at") or item.get("updatedAt"),
        "createdAt": item.get("createdAt"),
        "updatedAt": item.get("updatedAt"),
    }
