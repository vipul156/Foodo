"""Turn orchestrator — the service-layer brain between API and graph.

Responsibilities:
  - Load/create the Mongo session (scratch + history)
  - Invoke the LangGraph agent with a bounded tool loop
  - Persist updated scratch (draft) + history back to Mongo
  - Emit a checkout card whenever the draft is finalizable
  - Publish commerce.events fanout events (analytics-grade)
"""

from __future__ import annotations

import time
from typing import Any

from langchain_core.messages import HumanMessage

from pycommon.logging import get_logger

from app.agents import commerce_agent
from app.agents.tools import ToolContext
from app.clients.platform import PlatformClient
from app.core.config import get_settings
from app.schemas.commerce import (
    AgentTurnRequest,
    AgentTurnResponse,
    CheckoutCard,
    DraftOrderState,
    LineItem,
    PriceBreakdown,
)
from app.services.events import publish_commerce_event
from app.services.pricing import compute_pricing
from app.services.session_store import SessionStore

log = get_logger(__name__)
settings = get_settings()


class SessionNotFound(Exception):
    pass


class SessionLimitReached(Exception):
    pass


class Orchestrator:
    def __init__(self, store: SessionStore, platform: PlatformClient) -> None:
        self.store = store
        self.platform = platform
        self._graph = commerce_agent.build_graph()

    async def handle_turn(
        self,
        user_id: str,
        cookie_header: str,
        request: AgentTurnRequest,
    ) -> AgentTurnResponse:
        started = time.perf_counter()

        doc = await self._load_session(user_id, request.session_id)
        session_id = doc["session_id"]
        scratch: dict[str, Any] = doc.get("scratch") or {}
        history: list[dict[str, str]] = doc.get("history") or []

        if len(history) // 2 >= settings.session_max_turns:
            raise SessionLimitReached(
                "Conversation reached its turn limit — please start a new one"
            )

        # ─── Bounded graph invocation ────────────────────────────
        ctx = ToolContext(user_id=user_id, cookie_header=cookie_header, platform=self.platform)
        config = {
            "configurable": {"thread_id": session_id},
            "recursion_limit": settings.max_graph_steps,
        }
        state = commerce_agent.AgentState(
            messages=[HumanMessage(content=request.message)],
            tool_context={"_ctx": ctx},
            scratch=scratch,
            reply="",
            tool_trace=[],
            error=None,
        )
        final_state = await self._graph.ainvoke(state, config=config)

        # ─── Persist (history window + scratch incl. draft) ──────
        history = history + [
            {"role": "user", "content": request.message},
            {"role": "assistant", "content": final_state["reply"]},
        ]
        await self.store.save(
            user_id,
            session_id,
            draft=scratch.get("draft") or {"lines": []},
            history=history,
            scratch=scratch,
        )

        card = self._build_checkout_card(scratch)
        publish_commerce_event(
            "turn_completed",
            {
                "session_id": session_id,
                "user_id": user_id,
                "tool_calls": sum(
                    1 for s in final_state["tool_trace"] if s.get("type") == "tool_result"
                ),
                "duration_ms": int((time.perf_counter() - started) * 1000),
                "ready_to_pay": card.ready_to_pay if card else False,
            },
        )

        return AgentTurnResponse(
            session_id=session_id,
            reply=final_state["reply"],
            draft=self._draft_state(session_id, scratch),
            checkout_card=card,
            tool_trace=final_state["tool_trace"],
        )

    # ─── internals ───────────────────────────────────────────

    async def _load_session(self, user_id: str, session_id: str | None) -> dict[str, Any]:
        if session_id:
            doc = await self.store.get(user_id, session_id)
            if doc is None:
                raise SessionNotFound(session_id)
            return doc
        return await self.store.create(user_id)

    def _build_checkout_card(self, scratch: dict[str, Any]) -> CheckoutCard | None:
        draft = scratch.get("draft")
        if not draft or not draft.get("lines"):
            return None
        try:
            lines = [LineItem(**line) for line in draft["lines"]]
        except Exception:  # noqa: BLE001 — malformed draft never blocks the turn
            return None
        pricing = compute_pricing(lines)  # deterministic re-check at card time
        return CheckoutCard(
            restaurant_id=str(draft.get("restaurant_id") or ""),
            restaurant_name=str(draft.get("restaurant_name") or ""),
            lines=lines,
            pricing=pricing,
            requires_auth=True,
            ready_to_pay=True,
            messages=[],
        )

    def _draft_state(self, session_id: str, scratch: dict[str, Any]) -> DraftOrderState:
        draft = scratch.get("draft") or {}
        try:
            lines = [LineItem(**ln) for ln in (draft.get("lines") or [])]
        except Exception:  # noqa: BLE001
            lines = []
        pricing = None
        if draft.get("pricing"):
            try:
                pricing = PriceBreakdown(**draft["pricing"])
            except Exception:  # noqa: BLE001
                pricing = None
        return DraftOrderState(
            session_id=session_id,
            restaurant_id=draft.get("restaurant_id"),
            restaurant_name=draft.get("restaurant_name"),
            lines=lines,
            pricing=pricing,
            budget_cap=draft.get("budget_cap"),
            budget_note=draft.get("budget_note"),
            ready_to_pay=bool(lines),
            requires_auth=True,
            turn_count=len(scratch.get("history", [])) // 2,
        )
