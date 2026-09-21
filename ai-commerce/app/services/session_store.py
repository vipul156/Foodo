"""Conversation + draft-order session store.

Mongo (Motor, async) with a TTL index on updated_at bounds abandoned
drafts automatically — no sweeper process. The draft state IS the source
of truth for the checkout card; the LLM reads snapshots, never mutates it
directly (mutations flow through the mutator, which re-prices).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorCollection

from app.core.config import get_settings
from app.core.logging import get_logger
from app.schemas.commerce import DraftOrderState

log = get_logger(__name__)
settings = get_settings()

_COLLECTION = "commerce_sessions"


class SessionStore:
    def __init__(self, client: AsyncIOMotorClient) -> None:
        self._col: AsyncIOMotorCollection = client.get_default_database()[_COLLECTION]
        self._ready = False

    async def ensure_indexes(self) -> None:
        if self._ready:
            return
        await self._col.create_index("updated_at", expireAfterSeconds=0)
        await self._col.create_index([("user_id", 1), ("session_id", 1)], unique=True)
        self._ready = True

    async def create(self, user_id: str) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        session_id = f"c{int(now.timestamp() * 1000)}-{user_id[:8]}"
        doc = {
            "user_id": user_id,
            "session_id": session_id,
            "draft": DraftOrderState(session_id=session_id).model_dump(mode="json"),
            "history": [],
            "created_at": now,
            "updated_at": now,
        }
        await self._col.insert_one(doc)
        return doc

    async def get(self, user_id: str, session_id: str) -> dict[str, Any] | None:
        return await self._col.find_one({"user_id": user_id, "session_id": session_id})

    async def save(
        self,
        user_id: str,
        session_id: str,
        *,
        draft: dict[str, Any],
        history: list[dict[str, str]],
        scratch: dict[str, Any],
    ) -> None:
        now = datetime.now(timezone.utc)
        await self._col.update_one(
            {"user_id": user_id, "session_id": session_id},
            {
                "$set": {
                    "draft": draft,
                    "scratch": scratch,
                    "history": history[-settings.history_window * 2 :],
                    "updated_at": now,
                }
            },
            upsert=False,
        )

    async def list_for_user(self, user_id: str, limit: int = 10) -> list[dict[str, Any]]:
        cursor = (
            self._col.find({"user_id": user_id})
            .sort("updated_at", -1)
            .limit(limit)
        )
        return await cursor.to_list(length=limit)

    async def delete(self, user_id: str, session_id: str) -> int:
        result = await self._col.delete_one({"user_id": user_id, "session_id": session_id})
        return result.deleted_count or 0
