"""ai-dispatch — Autonomous Dispatch Swarm (FastAPI + LangGraph, serverless).

Boot sequence (each warm Lambda container):
  1. Configure logging
  2. Build the swarm service (state lives in DynamoDB: idempotency claims
     + the cross-time batching pool — nothing is held in process memory
     that a frozen container could silently drop)
  3. Serve the ops HTTP surface; the real intake is the SQS consumer.

The swarm is event-driven: order:ready_for_rider → SNS → dispatch queue →
consumer Lambda → graph → dispatch.decision on SNS + targeted rider
offers over realtime sockets.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import health_router, router
from app.core.config import get_settings
from app.core.logging import configure_logging, get_logger
from app.core.resilience import pools
from app.services.dispatch_service import get_service

settings = get_settings()
log = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_logging(settings.log_level)

    service = get_service()
    app.state.dispatch = service
    log.info("ai-dispatch ops surface up (intake = SQS consumer)")
    yield

    await pools.aclose()
    log.info("ai-dispatch shut down cleanly")


app = FastAPI(
    title="Foodo ai-dispatch",
    description=(
        "Autonomous dispatch swarm: kitchen prep prediction, fleet state "
        "scoring, SLA-bounded order batching, and a weather/congestion "
        "reflex — orchestrated as a LangGraph state machine with "
        "deterministic decision policy."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_url],
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

app.include_router(router)
app.include_router(health_router)
