"""ai-menu-parser — Multimodal Menu Digitization (FastAPI + Gemini).

Turns a smartphone photo of a printed menu into a validated, normalized
category/item tree for the human-in-the-loop review grid, then proxies
the owner-approved array to the restaurant service's bulk endpoint.

Boot sequence:
  1. Configure logging (fail-fast settings: GEMINI_API_KEY required)
  2. Serve HTTP — stateless service, no database of its own
"""

from __future__ import annotations

from fastapi import FastAPI

from pycommon.app import create_app, health_router
from pycommon.logging import configure_logging, get_logger

from app.api.routes import router
from app.core.config import get_settings
from app.core.resilience import pools

settings = get_settings()
log = get_logger(__name__)


async def _startup(app: FastAPI) -> None:
    configure_logging(settings.log_level)
    log.info("ai-menu-parser up on port %s (model=%s)", settings.port, settings.gemini_model)


async def _shutdown(app: FastAPI) -> None:
    await pools.aclose()
    log.info("ai-menu-parser shut down cleanly")


app = create_app(
    title="Foodo ai-menu-parser",
    description=(
        "Multimodal vision menu parsing: layout/column detection, "
        "entity-price association, dietary attribute tagging, and "
        "normalized JSON output for a human-in-the-loop review grid."
    ),
    settings=settings,
    routers=(router, health_router(settings.app_name)),
    allow_methods=("GET", "POST"),
    startup=_startup,
    shutdown=_shutdown,
)
