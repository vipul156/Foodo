"""HTTP surface — ops/observability only. The real intake is the MQ event.

Endpoints:
  GET  /health                        — liveness (LB probe)
  GET  /api/dispatch/snapshot         — swarm health + pending pool (internal)
  POST /api/dispatch/simulate         — inject a ready event (internal; staging tool)
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.core.config import get_settings
from app.schemas.dispatch import OrderReadyEvent

settings = get_settings()
router = APIRouter(prefix="/api/dispatch", tags=["dispatch"])


def require_internal(request: Request) -> None:
    """Fail-closed internal-key check (mirrors the Node middlewares)."""
    if request.headers.get("x-internal-key") != settings.internal_service_key:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Forbidden")


@router.get("/snapshot", dependencies=[Depends(require_internal)])
async def snapshot(request: Request) -> dict:
    service = request.app.state.dispatch
    return {"success": True, **service.snapshot()}


@router.post("/simulate", dependencies=[Depends(require_internal)])
async def simulate(request: Request, event: OrderReadyEvent) -> dict:
    """Staging tool: run the swarm on a synthetic ready event.

    Never call from untrusted networks — it consumes real dispatch
    capacity. Internal-key protected like every other mutation.
    """
    service = request.app.state.dispatch
    await service.handle_event(event.model_dump(by_alias=True))
    return {"success": True, "message": "dispatch graph executed"}

