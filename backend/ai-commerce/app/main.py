"""ai-commerce — Conversational Commerce & Ordering Agent (serverless Lambda).

Boot sequence (per warm container):
  1. Configure logging
  2. Serve HTTP via Mangum; sessions/drafts persist in DynamoDB
     (TTL-bounded), decisions/events ride the platform SNS topic.

The LangGraph agent and platform clients are built lazily by the route
module — nothing connection-shaped to hold across invocations.
"""

from __future__ import annotations

from fastapi import FastAPI

from pycommon.app import create_app, health_router
from pycommon.logging import configure_logging, get_logger

from app.api.routes import router as commerce_router
from app.core.config import get_settings
from app.core.resilience import pools

settings = get_settings()
log = get_logger(__name__)


async def _startup(app: FastAPI) -> None:
    configure_logging(settings.log_level)
    log.info("ai-commerce up (http via Mangum; store = DynamoDB)")


async def _shutdown(app: FastAPI) -> None:
    await pools.aclose()
    log.info("ai-commerce shut down cleanly")


app = create_app(
    title="Foodo ai-commerce",
    description=(
        "Multi-turn conversational ordering agent: entity resolution over order "
        "history, semantic menu search, draft cart mutation with deterministic "
        "pricing, and an explicit-auth checkout hand-off."
    ),
    settings=settings,
    routers=(commerce_router, health_router(settings.app_name)),
    allow_methods=("GET", "POST", "DELETE"),
    startup=_startup,
    shutdown=_shutdown,
)
