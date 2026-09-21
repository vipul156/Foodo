"""HTTP surface — thin controllers over the orchestrator.

Endpoints (all user-session authenticated, fail-closed):
  POST /api/commerce/turn      — converse; mutates the DRAFT only
  GET  /api/commerce/draft     — current draft state for the UI
  GET  /api/commerce/summary   — checkout card (requires_auth enforced)
  GET  /api/commerce/sessions  — list active sessions for the user
  DELETE /api/commerce/session — abandon the current conversation
  GET  /health                 — liveness probe
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.deps import get_cookie_header, get_platform
from app.clients.platform import PlatformClient
from app.core.config import get_settings
from app.core.ratelimit import enforce_rate_limit
from app.core.security import Identity, require_user
from app.schemas.commerce import AgentTurnRequest, AgentTurnResponse, CheckoutCard
from app.services.db import database
from app.services.orchestrator import Orchestrator, SessionLimitReached, SessionNotFound
from app.services.session_store import SessionStore

settings = get_settings()
router = APIRouter(prefix="/api/commerce", tags=["commerce"])

# Singletons (process-wide); the platform client is shared, the store rides
# the shared Motor client.
_platform = get_platform()
_store: SessionStore | None = None
_orchestrator: Orchestrator | None = None


def _get_store() -> SessionStore:
    global _store
    if _store is None:
        if database.client is None:
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE, "Storage unavailable"
            )
        _store = SessionStore(database.client)
        _store._ready = False  # indexes created lazily on first use
    return _store


def get_orchestrator() -> Orchestrator:
    global _orchestrator
    if _orchestrator is None:
        _orchestrator = Orchestrator(_get_store(), _platform)
    return _orchestrator


# ─── POST /turn — the conversational entrypoint ──────────────

@router.post("/turn", response_model=AgentTurnResponse)
async def converse(
    request: AgentTurnRequest,
    identity: Identity = Depends(require_user),
    cookie_header: str = Depends(get_cookie_header),
    platform: PlatformClient = Depends(get_platform),
) -> AgentTurnResponse:
    await enforce_rate_limit(f"commerce:{identity.user_id}")

    orchestrator = get_orchestrator()
    try:
        return await orchestrator.handle_turn(
            user_id=identity.user_id,
            cookie_header=cookie_header,
            request=request,
        )
    except SessionLimitReached as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc))
    except SessionNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found or expired")


# ─── GET /draft — current draft for UI hydration ─────────────

@router.get("/draft")
async def get_draft(
    session_id: str,
    identity: Identity = Depends(require_user),
) -> dict:
    store = _get_store()
    doc = await store.get(identity.user_id, session_id)
    if doc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")
    return {"success": True, "draft": doc.get("draft", {}), "scratch": doc.get("scratch", {})}


# ─── GET /summary — the checkout card contract ───────────────

@router.get("/summary", response_model=CheckoutCard)
async def get_summary(
    session_id: str,
    identity: Identity = Depends(require_user),
) -> CheckoutCard:
    store = _get_store()
    doc = await store.get(identity.user_id, session_id)
    if doc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")

    from app.services.orchestrator import Orchestrator

    card = Orchestrator._build_checkout_card(Orchestrator, doc.get("scratch") or {})
    if card is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Draft is empty — nothing to check out")
    # requires_auth is a server-set constant: the UI must show the
    # explicit-confirm step before any payment call. It is never derived
    # from client input.
    return card


# ─── GET /sessions — active conversations for the user ───────

@router.get("/sessions")
async def list_sessions(identity: Identity = Depends(require_user)) -> dict:
    store = _get_store()
    sessions = await store.list_for_user(identity.user_id, limit=10)
    return {
        "success": True,
        "sessions": [
            {
                "session_id": s["session_id"],
                "updated_at": s.get("updated_at"),
                "has_draft": bool((s.get("draft") or {}).get("lines")),
            }
            for s in sessions
        ],
    }


# ─── DELETE /session — abandon a conversation ────────────────

@router.delete("/session")
async def delete_session(
    session_id: str,
    identity: Identity = Depends(require_user),
) -> dict:
    store = _get_store()
    deleted = await store.delete(identity.user_id, session_id)
    if deleted == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")
    return {"success": True}


# ─── GET /health — liveness (no auth; behind the LB) ─────────

health_router = APIRouter(tags=["ops"])


@health_router.get("/health")
async def health() -> dict:
    return {
        "status": "UP",
        "service": settings.app_name,
        "timestamp": __import__("time").time(),
    }
