"""ai-dispatch — Autonomous Dispatch Swarm (FastAPI + LangGraph).

Boot sequence:
  1. Configure logging
  2. Connect Redis (optional) for idempotency + pool sharing
  3. Connect RabbitMQ (robust auto-reconnect) and attach the consumer
  4. Serve the ops HTTP surface

The swarm is event-driven: order:ready_for_rider → graph → decisions on
dispatch.events + targeted rider offers over realtime sockets.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import health_router, router
from app.clients.platform import PlatformClient
from app.core.config import get_settings
from app.core.logging import configure_logging, get_logger
from app.core.resilience import pools
from app.services.dispatch_service import DispatchService
from app.services.mq import MessageBus

settings = get_settings()
log = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_logging(settings.log_level)

    # Redis (optional) — multi-pod idempotency + shared pending pool.
    redis = None
    if settings.redis_url:
        from redis.asyncio import Redis

        redis = Redis.from_url(settings.redis_url, decode_responses=True)
        await redis.ping()
        log.info("Redis connected (multi-pod idempotency)")

    bus = MessageBus()
    service = DispatchService(PlatformClient(), bus, redis=redis)
    bus.on_order_event(service.handle_event)
    app.state.dispatch = service

    await bus.start()  # robust connection; consumer re-attaches on reconnect
    log.info("ai-dispatch up on port %s", settings.port)
    yield

    await bus.close()
    await pools.aclose()
    if redis is not None:
        await redis.aclose()
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
