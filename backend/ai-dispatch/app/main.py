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

from fastapi import FastAPI

from pycommon.app import create_app, health_router
from pycommon.logging import configure_logging, get_logger

from app.api.routes import router
from app.core.config import get_settings
from app.core.resilience import pools
from app.services.dispatch_service import get_service

settings = get_settings()
log = get_logger(__name__)


async def _startup(app: FastAPI) -> None:
    configure_logging(settings.log_level)

    service = get_service()
    app.state.dispatch = service
    log.info("ai-dispatch ops surface up (intake = SQS consumer)")


async def _shutdown(app: FastAPI) -> None:
    await pools.aclose()
    log.info("ai-dispatch shut down cleanly")


app = create_app(
    title="Foodo ai-dispatch",
    description=(
        "Autonomous dispatch swarm: kitchen prep prediction, fleet state "
        "scoring, SLA-bounded order batching, and a weather/congestion "
        "reflex — orchestrated as a LangGraph state machine with "
        "deterministic decision policy."
    ),
    settings=settings,
    routers=(router, health_router(settings.app_name)),
    allow_methods=("GET", "POST"),
    startup=_startup,
    shutdown=_shutdown,
)
