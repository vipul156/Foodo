"""FastAPI app factory — the service skeleton every Python service shares.

The three services differed only in their CORS method list and their
boot/shutdown hooks; the wiring itself was copy-paste. This module owns
the wiring, each service owns its own description and hooks.
"""

from __future__ import annotations

import time
from contextlib import asynccontextmanager
from typing import AsyncIterator, Awaitable, Callable, Sequence

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from pycommon.config import BaseServiceSettings


def health_router(service_name: str) -> APIRouter:
    """The ``/health`` probe every service exposes to the gateway."""
    router = APIRouter(tags=["ops"])

    @router.get("/health")
    async def health() -> dict:
        return {
            "status": "UP",
            "service": service_name,
            "timestamp": time.time(),
        }

    return router


def create_app(
    *,
    title: str,
    description: str,
    settings: BaseServiceSettings,
    routers: Sequence[APIRouter] = (),
    allow_methods: Sequence[str] = ("GET", "POST"),
    startup: Callable[[FastAPI], Awaitable[None]] | None = None,
    shutdown: Callable[[FastAPI], Awaitable[None]] | None = None,
    version: str = "1.0.0",
) -> FastAPI:
    """Build the FastAPI app: CORS, routers and the boot/shutdown hooks."""

    async def _noop(_app: FastAPI) -> None:
        return None

    if startup is None:
        startup = _noop
    if shutdown is None:
        shutdown = _noop

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        await startup(app)
        try:
            yield
        finally:
            await shutdown(app)

    app = FastAPI(
        title=title,
        description=description,
        version=version,
        lifespan=lifespan,
    )

    # CORS: the browser talks to these services only through Next.js
    # rewrites in dev; direct CORS is for API tooling.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.frontend_url],
        allow_credentials=True,
        allow_methods=list(allow_methods),
        allow_headers=["*"],
    )

    for router in routers:
        app.include_router(router)

    return app
