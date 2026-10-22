"""LangChain tool definitions — strict Pydantic args, typed returns.

The LLM only emits calls against these schemas; execution is deterministic
code against platform REST endpoints. User identity + session cookies
travel via ToolContext (bound server-side at invocation time — never
chosen by the model).

Two registries per tool:
  - TOOL_SPECS   → StructuredTool objects given to the LLM (name/schema/description)
  - TOOL_FUNCS   → the raw coroutines my tools-node executes with (input, ctx)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from pycommon.logging import get_logger

from app.clients.platform import PlatformClient, PlatformUnavailable
from app.schemas.commerce import PastOrderRef

log = get_logger(__name__)


@dataclass
class ToolContext:
    """Per-turn execution context — bound server-side, invisible to the LLM."""

    user_id: str
    cookie_header: str
    platform: PlatformClient
    # Cross-turn AND cross-tool state (the draft lives here, orchestrator persists it)
    scratch: dict[str, Any] = field(default_factory=dict)


ToolFunc = Callable[[BaseModel, ToolContext], Awaitable[dict]]


# ─── Tool 1: order history ───────────────────────────────────

class GetPastOrdersInput(BaseModel):
    limit: int = Field(default=5, ge=1, le=20, description="How many recent orders to fetch")


async def _get_past_orders(input: GetPastOrdersInput, ctx: ToolContext) -> dict:
    try:
        orders = await ctx.platform.get_past_orders(
            ctx.user_id, ctx.cookie_header, limit=input.limit
        )
    except PlatformUnavailable as exc:
        return {"ok": False, "error": str(exc)}
    refs = [
        PastOrderRef(
            order_id=str(o.get("_id", "")),
            restaurant_id=str(o.get("restaurantId", "")),
            restaurant_name=str(o.get("restaurantName", "")),
            created_at=str(o.get("createdAt", "")),
            status=str(o.get("status", "")),
            total_amount=float(o.get("totalAmount", 0) or 0),
            items=[str(i.get("name", "")) for i in (o.get("items") or [])],
        ).model_dump()
        for o in orders
    ]
    ctx.scratch["past_orders"] = refs
    return {"ok": True, "orders": refs}


# ─── Tool 2: semantic menu search ────────────────────────────

class SearchMenuItemsInput(BaseModel):
    restaurant_id: str = Field(description="Restaurant to search (24-hex ObjectId)")
    query: str = Field(min_length=2, max_length=120, description="Fuzzy item description")
    limit: int = Field(default=5, ge=1, le=10)


async def _search_menu_items(input: SearchMenuItemsInput, ctx: ToolContext) -> dict:
    try:
        menu = await ctx.platform.get_menu(input.restaurant_id)
    except PlatformUnavailable as exc:
        return {"ok": False, "error": str(exc)}

    from app.services.menu_search import rank_menu

    candidates = await rank_menu(menu, input.query, limit=input.limit)
    payload = [
        {
            "item_id": c.item_id,
            "restaurant_id": c.restaurant_id,
            "name": c.name,
            "price": float(c.item.get("price", 0)),
            "category": str(c.item.get("category", "")),
            "score": c.score,
        }
        for c in candidates
    ]
    ctx.scratch["last_menu_search"] = {
        "restaurant_id": input.restaurant_id,
        "query": input.query,
        "candidates": payload,
    }
    return {"ok": True, "candidates": payload, "menu_size": len(menu)}


# ─── Draft mutation tools (in-memory until checkout applies them) ──

def _draft(scratch: dict[str, Any]) -> dict:
    return scratch.setdefault("draft", {"lines": [], "pricing": None, "budget_cap": None, "over_budget": False})


class DraftAddInput(BaseModel):
    item_id: str = Field(description="MenuItem ObjectId from search_menu_items")
    name: str = Field(description="Exact menu name of the item")
    unit_price: float = Field(ge=0, description="Price PER UNIT from the menu — never estimated")
    quantity: int = Field(default=1, ge=1, le=20)
    customizations: list[str] = Field(default_factory=list, description='e.g. ["extra cheese"]')


async def _draft_add_item(input: DraftAddInput, ctx: ToolContext) -> dict:
    draft = _draft(ctx.scratch)
    if len(draft["lines"]) >= 25:
        return {"ok": False, "error": "Draft order is full (25 lines max)"}
    draft["lines"].append(
        {
            "item_id": input.item_id,
            "name": input.name,
            "unit_price": input.unit_price,
            "quantity": input.quantity,
            "customizations": input.customizations,
        }
    )
    return {"ok": True, "lines": draft["lines"]}


class DraftSwapInput(BaseModel):
    remove_item_id: str = Field(description="item_id currently in the draft to remove")
    add_item_id: str = Field(description="Replacement MenuItem ObjectId")
    add_name: str
    add_unit_price: float = Field(ge=0)
    add_quantity: int = Field(default=1, ge=1, le=20)
    reason: str = Field(default="", max_length=200)


async def _draft_swap_item(input: DraftSwapInput, ctx: ToolContext) -> dict:
    draft = _draft(ctx.scratch)
    before = len(draft["lines"])
    draft["lines"] = [ln for ln in draft["lines"] if ln["item_id"] != input.remove_item_id]
    removed = before != len(draft["lines"])
    draft["lines"].append(
        {
            "item_id": input.add_item_id,
            "name": input.add_name,
            "unit_price": input.add_unit_price,
            "quantity": input.add_quantity,
            "customizations": [],
        }
    )
    return {"ok": True, "removed": removed, "lines": draft["lines"]}


class DraftRemoveInput(BaseModel):
    item_id: str = Field(description="item_id in the draft to remove")


async def _draft_remove_item(input: DraftRemoveInput, ctx: ToolContext) -> dict:
    draft = _draft(ctx.scratch)
    before = len(draft["lines"])
    draft["lines"] = [ln for ln in draft["lines"] if ln["item_id"] != input.item_id]
    return {"ok": True, "removed": before != len(draft["lines"]), "lines": draft["lines"]}


class DraftUpdateQtyInput(BaseModel):
    item_id: str
    quantity: int = Field(ge=0, le=20, description="Absolute new quantity; 0 removes the line")


async def _draft_update_quantity(input: DraftUpdateQtyInput, ctx: ToolContext) -> dict:
    draft = _draft(ctx.scratch)
    for line in draft["lines"]:
        if line["item_id"] == input.item_id:
            if input.quantity == 0:
                draft["lines"].remove(line)
            else:
                line["quantity"] = input.quantity
            return {"ok": True, "lines": draft["lines"]}
    return {"ok": False, "error": "item not in draft"}


# ─── Draft context (restaurant binding) ──────────────────────

class DraftSetRestaurantInput(BaseModel):
    restaurant_id: str = Field(description="Restaurant ObjectId (24-hex)")
    restaurant_name: str = Field(max_length=120)


async def _draft_set_restaurant(input: DraftSetRestaurantInput, ctx: ToolContext) -> dict:
    """Bind the draft to one restaurant (single-restaurant cart rule).

    Switching restaurants clears the draft — mirrors the platform's cart
    constraint (one restaurant per cart) and keeps swaps honest.
    """
    draft = _draft(ctx.scratch)
    previous = draft.get("restaurant_id")
    if previous and previous != input.restaurant_id:
        draft["lines"] = []
        draft["pricing"] = None
        draft["switched_from"] = previous
    draft["restaurant_id"] = input.restaurant_id
    draft["restaurant_name"] = input.restaurant_name
    return {
        "ok": True,
        "restaurant_id": input.restaurant_id,
        "restaurant_name": input.restaurant_name,
        "cleared_lines": previous is not None and previous != input.restaurant_id,
    }


# ─── Finalize: deterministic pricing + budget guard ──────────

class DraftFinalizeInput(BaseModel):
    budget_cap: float | None = Field(
        default=None, ge=0, description="Max total the user will accept, if stated"
    )


async def _draft_finalize(input: DraftFinalizeInput, ctx: ToolContext) -> dict:
    from app.schemas.commerce import LineItem
    from app.services.pricing import compute_pricing

    draft = _draft(ctx.scratch)
    try:
        lines = [LineItem(**line) for line in draft["lines"]]
    except Exception as exc:  # noqa: BLE001 — malformed draft lines never reach pricing
        return {"ok": False, "error": f"invalid draft line: {exc}"}
    pricing = compute_pricing(lines)
    over_budget = input.budget_cap is not None and pricing.total > input.budget_cap
    draft["pricing"] = pricing.model_dump()
    if input.budget_cap is not None:
        draft["budget_cap"] = input.budget_cap
    draft["over_budget"] = over_budget
    return {
        "ok": True,
        "pricing": pricing.model_dump(),
        "over_budget": over_budget,
        "line_count": len(draft["lines"]),
    }


# ─── Registries ──────────────────────────────────────────────

_TOOL_DEFS: list[tuple[StructuredTool, ToolFunc]] = [
    (
        StructuredTool.from_function(
            coroutine=_get_past_orders,
            name="get_past_orders",
            description=(
                "Fetch the user's recent orders. Use FIRST when the user references a "
                "previous order ('the place I ordered from last Tuesday', 'my usual'). "
                "Returns restaurant names, item lists, totals."
            ),
            args_schema=GetPastOrdersInput,
        ),
        _get_past_orders,
    ),
    (
        StructuredTool.from_function(
            coroutine=_search_menu_items,
            name="search_menu_items",
            description=(
                "Semantic menu search — maps fuzzy phrases to real menu items with ids. "
                "Required before adding ANY item ('that spicy paneer starter', 'chicken "
                "burger'). Returns candidates with item_id, unit price, match score; "
                "confirm with the user when scores are low or close."
            ),
            args_schema=SearchMenuItemsInput,
        ),
        _search_menu_items,
    ),
    (
        StructuredTool.from_function(
            coroutine=_draft_add_item,
            name="draft_add_item",
            description=(
                "Add an item to the draft order. Only items from search_menu_items — "
                "reuse item_id/name/unit_price EXACTLY as returned. Prices come from "
                "the menu, never from the user or your own estimate."
            ),
            args_schema=DraftAddInput,
        ),
        _draft_add_item,
    ),
    (
        StructuredTool.from_function(
            coroutine=_draft_swap_item,
            name="draft_swap_item",
            description=(
                "Swap a draft line: remove one item and add another ('switch the fries "
                "for onion rings'). Replacement must come from search_menu_items."
            ),
            args_schema=DraftSwapInput,
        ),
        _draft_swap_item,
    ),
    (
        StructuredTool.from_function(
            coroutine=_draft_remove_item,
            name="draft_remove_item",
            description="Remove an item from the draft order entirely.",
            args_schema=DraftRemoveInput,
        ),
        _draft_remove_item,
    ),
    (
        StructuredTool.from_function(
            coroutine=_draft_update_quantity,
            name="draft_update_quantity",
            description="Set the quantity of a draft line (absolute, not incremental).",
            args_schema=DraftUpdateQtyInput,
        ),
        _draft_update_quantity,
    ),
    (
        StructuredTool.from_function(
            coroutine=_draft_set_restaurant,
            name="draft_set_restaurant",
            description=(
                "Bind the draft order to a restaurant before adding items. Switching "
                "restaurants clears the draft (one restaurant per order). Get the id "
                "from get_past_orders or the user.·"
            ),
            args_schema=DraftSetRestaurantInput,
        ),
        _draft_set_restaurant,
    ),
    (
        StructuredTool.from_function(
            coroutine=_draft_finalize,
            name="draft_finalize",
            description=(
                "Compute the authoritative price breakdown (deterministic server math — "
                "taxes/fees). Call ONCE after mutations. If over_budget and the user set "
                "a cap, trim the order (fewer/cheaper items) and finalize again."
            ),
            args_schema=DraftFinalizeInput,
        ),
        _draft_finalize,
    ),
]

TOOL_SPECS: list[StructuredTool] = [spec for spec, _ in _TOOL_DEFS]
TOOL_FUNCS: dict[str, ToolFunc] = {
    spec.name: fn for spec, fn in _TOOL_DEFS
}
