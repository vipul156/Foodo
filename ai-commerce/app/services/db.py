"""Mongo (Motor) + optional Redis lifecycle for the FastAPI app.

- Mongo holds conversation sessions (TTL-bounded drafts).
- Redis is OPTIONAL: when REDIS_URL is set, rate limiting becomes
  multi-pod correct; otherwise an in-process sliding window is used
  (single-pod dev parity with the Node services' memory store).
"""

from __future__ import annotations

from typing import AsyncIterator

from motor.motor_asyncio import AsyncIOMotorClient
from redis.asyncio import Redis

from app.core.config import get_settings
from app.core.logging import get_logger

log = get_logger(__name__)
settings = get_settings()


class Database:
    def __init__(self) -> None:
        self.client: AsyncIOMotorClient | None = None
        self.redis: Redis | None = None

    async def connect(self) -> None:
        self.client = AsyncIOMotorClient(settings.mongo_uri, serverSelectionTimeoutMS=5000)
        # Fail fast at boot if Mongo is unreachable — the service is
        # useless (and unsafe to serve drafts from memory) without it.
        await self.client.admin.command("ping")
        log.info("Mongo connected")

        if settings.redis_url:
            self.redis = Redis.from_url(settings.redis_url, decode_responses=True)
            await self.redis.ping()
            log.info("Redis connected (multi-pod rate limiting)")
        else:
            log.info("Redis not configured — in-process rate limiting")

    async def close(self) -> None:
        if self.redis is not None:
            await self.redis.aclose()
        if self.client is not None:
            self.client.close()


database = Database()
