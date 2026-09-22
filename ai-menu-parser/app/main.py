"""ai-menu-parser — Multimodal Menu Digitization (FastAPI + Gemini).

Turns a smartphone photo of a printed menu into a validated, normalized
category/item tree for the human-in-the-loop review grid, then proxies
the owner-approved array to the restaurant service's bulk endpoint.

Boot sequence:
  1. Configure logging (fail-fast settings: GEMINI_API_KEY required)
  2. Serve HTTP — stateless service, no database of its own
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import health_router, router
from app.core.config import get_settings
from app.core.logging import configure_logging, get_logger
from app.core.resilience import pools

settings = get_settings()
log = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_logging(settings.log_level)
    log.info("ai-menu-parser up on port %s (model=%s)", settings.port, settings.gemini_model)
    yield
    await pools.aclose()
    log.info("ai-menu-parser shut down cleanly")


app = FastAPI(
    title="Foodo ai-menu-parser",
    description=(
        "Multimodal vision menu parsing: layout/column detection, "
        "entity-price association, dietary attribute tagging, and "
        "normalized JSON output for a human-in-the-loop review grid."
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
