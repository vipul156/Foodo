"""The conversational commerce agent (LangGraph state machine).

Per turn:  load_session → agent (LLM ⇄ tools, bounded) → persist_session

Design invariants:
  - The model proposes tool calls against strict Pydantic schemas only.
  - Tool execution is deterministic code (my tools node), with the
    ToolContext bound server-side — the LLM never sees cookies or DBs.
  - Pricing is computed in Python (draft_finalize); the model never does
    math.
  - Draft state persists in Mongo; the LLM reads snapshots via the system
    prompt, never mutates the store directly.
"""

from __future__ import annotations

import json
import time
from typing import Annotated, Any, Literal, TypedDict

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    SystemMessage,
    ToolMessage,
)
from langgraph.graph import END, StateGraph
from langgraph.graph.message import add_messages

from pycommon.llm import build_chat_model
from pycommon.logging import get_logger

from app.agents.tools import TOOL_FUNCS, TOOL_SPECS, ToolContext
from app.core.config import get_settings

settings = get_settings()
log = get_logger(__name__)

# The per-turn tool loop is bounded by LangGraph's recursion_limit
# (settings.max_graph_steps) — an LLM that keeps calling tools is cut off
# deterministically instead of burning tokens forever.


# ─── Graph state ─────────────────────────────────────────────

class AgentState(TypedDict):
    # `add_messages` is mandatory, not decoration: without a reducer the
    # channel is last-value-wins, so the agent node's AIMessage REPLACED
    # the human turn and the next LLM call saw a conversation with no
    # user message — every tool loop died on the second call (the model
    # API rejects a tool-only transcript).
    messages: Annotated[list[BaseMessage], add_messages]
    # Serialized ToolContext inputs — the PlatformClient instance itself is
    # injected by the orchestrator into state via a private key.
    tool_context: dict[str, Any]
    scratch: dict[str, Any]
    reply: str
    tool_trace: list[dict[str, Any]]
    error: str | None


# ─── System prompt — fencing + tool discipline ───────────────

SYSTEM_PROMPT = """You are Foodo's food-ordering assistant. You help users build \
a food order conversationally. You NEVER invent menu items, restaurants, or prices.

## Non-negotiable rules
1. IDs and prices come ONLY from tool outputs — never from memory or the \
user's claims. If the user says "the ₹60 burger" but the menu says 79, the \
menu wins.
2. Any item the user mentions must be resolved with search_menu_items \
before adding. If no candidate is plausible, tell the user you couldn't \
find it and show the closest options.
3. For "my usual"/"the place from last Tuesday", call get_past_orders \
first, then search_menu_items for that restaurant.
4. The draft order is the source of truth. After every mutation batch, \
call draft_finalize ONCE to compute the authoritative price breakdown. \
Never compute or promise prices yourself — quote only totals returned by \
draft_finalize.
5. If the user stated a budget and draft_finalize reports over_budget=true, \
proactively trim: reduce quantities or swap to cheaper items via the draft \
tools, then finalize again. Say what you changed.
6. If a tool returns ok:false, tell the user plainly and continue — never \
retry more than twice, never invent an outcome.
7. Nothing is purchased automatically. The draft becomes a real order only \
after the user presses Pay in the app.

## Output style
Under 80 words, friendly, concrete: restate items, quantities, \
customizations and the final total from draft_finalize. Ask ONE \
clarifying question when something is ambiguous (which restaurant, which \
size, confirm a swap)."""


# ─── LLM ─────────────────────────────────────────────────────

_llm: BaseChatModel | None = None


def get_llm() -> BaseChatModel:
    """One model per warm container.

    LLM_PROVIDER picks the vendor (groq, openai, openrouter, ollama, or
    anything reachable through LLM_BASE_URL) — all over the OpenAI
    Chat Completions wire format.
    """
    global _llm
    if _llm is None:
        _llm = build_chat_model(settings.llm)
    return _llm


def _tool_bound_llm():
    return get_llm().bind_tools(TOOL_SPECS)


# ─── Draft snapshot for the system prompt ────────────────────

def _draft_snapshot(scratch: dict[str, Any]) -> str:
    draft = scratch.get("draft")
    if not draft or not draft.get("lines"):
        return "Draft order: (empty)"
    lines = [
        {
            "item_id": ln["item_id"],
            "name": ln["name"],
            "qty": ln["quantity"],
            "unit_price": ln["unit_price"],
            "customizations": ln.get("customizations", []),
        }
        for ln in draft["lines"]
    ]
    pricing = draft.get("pricing")
    budget = draft.get("budget_cap")
    parts = [f"Draft order: {json.dumps(lines, default=str)}"]
    if pricing:
        parts.append(f"Pricing: {json.dumps(pricing)}")
    if budget is not None:
        parts.append(f"Budget cap: {budget} (over_budget={draft.get('over_budget')})")
    return " | ".join(parts)


# ─── Nodes ───────────────────────────────────────────────────

async def agent_node(state: AgentState) -> dict[str, Any]:
    """One LLM call with tools bound — the conditional edge drives the loop."""
    ctx_data = state["tool_context"]
    scratch = state["scratch"]

    system = f"{SYSTEM_PROMPT}\n\n## Current draft state\n{_draft_snapshot(scratch)}"
    messages: list[BaseMessage] = [SystemMessage(content=system)] + list(state["messages"])

    response = await _tool_bound_llm().ainvoke(messages)

    trace = list(state.get("tool_trace", []))
    if response.tool_calls:
        trace.append(
            {
                "node": "agent",
                "type": "llm_tool_calls",
                "calls": [
                    {"name": tc["name"], "args": tc["args"]} for tc in response.tool_calls
                ],
                "at": time.time(),
            }
        )
    return {"messages": [response], "tool_trace": trace}


async def tools_node(state: AgentState) -> dict[str, Any]:
    """Deterministic tool execution with server-bound context + full trace."""
    ctx_data = state["tool_context"]
    ctx: ToolContext = ctx_data["_ctx"]

    last: AIMessage | None = None
    for message in reversed(state["messages"]):
        if isinstance(message, AIMessage):
            last = message
            break

    trace = list(state.get("tool_trace", []))
    outputs: list[ToolMessage] = []
    if last is None or not last.tool_calls:
        return {"messages": outputs, "tool_trace": trace}

    for call in last.tool_calls:
        name = call["name"]
        started = time.perf_counter()
        try:
            func = TOOL_FUNCS.get(name)
            if func is None:
                result = {"ok": False, "error": f"unknown tool {name}"}
            else:
                # Strict validation: raw dict → Pydantic input model.
                input_model = _input_model_for(name)
                if input_model is None:
                    result = {"ok": False, "error": f"no schema for tool {name}"}
                else:
                    parsed = input_model.model_validate(call.get("args") or {})
                    result = await func(parsed, ctx)
        except Exception as exc:  # noqa: BLE001 — a tool crash is a tool error, not a 500
            log.exception("tool %s crashed", name)
            result = {"ok": False, "error": f"internal tool error: {exc}"}
        duration_ms = int((time.perf_counter() - started) * 1000)

        trace.append(
            {
                "node": "tools",
                "type": "tool_result",
                "tool": name,
                "ok": bool(result.get("ok")),
                "error": result.get("error"),
                "duration_ms": duration_ms,
                "at": time.time(),
            }
        )
        outputs.append(
            ToolMessage(
                content=json.dumps(result, default=str),
                tool_call_id=call["id"],
            )
        )
    return {"messages": outputs, "tool_trace": trace}


def _input_model_for(name: str):
    from app.agents import tools as tools_module

    mapping = {
        "get_past_orders": tools_module.GetPastOrdersInput,
        "search_menu_items": tools_module.SearchMenuItemsInput,
        "draft_set_restaurant": tools_module.DraftSetRestaurantInput,
        "draft_add_item": tools_module.DraftAddInput,
        "draft_swap_item": tools_module.DraftSwapInput,
        "draft_remove_item": tools_module.DraftRemoveInput,
        "draft_update_quantity": tools_module.DraftUpdateQtyInput,
        "draft_finalize": tools_module.DraftFinalizeInput,
    }
    return mapping.get(name)


def route_after_agent(state: AgentState) -> Literal["tools", "__end__"]:
    last: AIMessage | None = None
    for message in reversed(state["messages"]):
        if isinstance(message, AIMessage):
            last = message
            break
    if last is not None and last.tool_calls:
        return "tools"
    return "__end__"


async def persist_node(state: AgentState) -> dict[str, Any]:
    """Terminal node — extract the final reply; scratch (incl. draft) is
    persisted by the orchestrator after graph.ainvoke returns."""
    reply = ""
    for message in reversed(state["messages"]):
        if isinstance(message, AIMessage) and not message.tool_calls:
            reply = message.content if isinstance(message.content, str) else str(message.content)
            break
    return {"reply": reply or "I'm here — how can I help with your order?"}


# ─── Graph assembly ──────────────────────────────────────────

def build_graph():
    graph = StateGraph(AgentState)
    graph.add_node("agent", agent_node)
    graph.add_node("tools", tools_node)
    graph.add_node("persist", persist_node)

    graph.set_entry_point("agent")
    graph.add_conditional_edges(
        "agent",
        route_after_agent,
        {"tools": "tools", "__end__": "persist"},
    )
    graph.add_edge("tools", "agent")  # bounded by MAX_TOOL_ROUNDS via orchestrator
    graph.add_edge("persist", END)
    return graph.compile()


commerce_graph = build_graph()
