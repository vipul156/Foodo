"""ai-commerce — Conversational Commerce & Ordering Agent (serverless Lambda).

Boot sequence (per warm container):
  1. Configure logging
  2. Serve HTTP via Mangum; sessions/drafts persist in DynamoDB
     (TTL-bounded), decisions/events ride the platform SNS topic.

The LangGraph agent and platform clients are built lazily by the route
module — nothing connection-shaped to hold across invocations.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import health_router, router as commerce_router
from app.core.config import get_settings
from app.core.logging import configure_logging, get_logger
from app.core.resilience import pools

settings = get_settings()
log = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_logging(settings.log_level)
    log.info("ai-commerce up (http via Mangum; store = DynamoDB)")
    yield
    await pools.aclose()
    log.info("ai-commerce shut down cleanly")


app = FastAPI(
    title="Foodo ai-commerce",
    description=(
        "Multi-turn conversational ordering agent: entity resolution over order "
        "history, semantic menu search, draft cart mutation with deterministic "
        "pricing, and an explicit-auth checkout hand-off."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

# CORS: the browser talks to this service only through Next.js rewrites in
# dev; direct CORS is for API tooling.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_url],
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["*"],
)

app.include_router(commerce_router)
app.include_router(health_router)
