"""Pydantic v2 contracts — the typed boundary between LLM and database.

The model NEVER writes to the database. It emits strict tool calls against
these schemas; validation happens in Pydantic, execution happens against
the existing Node REST endpoints, and pricing is computed in Python.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from enum import Enum
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, field_validator

# ─── Shared primitives ───────────────────────────────────────

ObjectIdStr = Annotated[str, Field(pattern=r"^[0-9a-fA-F]{24}$")]


class Tone(str, Enum):
    NEUTRAL = "neutral"


# ─── Step 1: order history resolution ────────────────────────

class PastOrderRef(BaseModel):
    order_id: str
    restaurant_id: str
    restaurant_name: str
    created_at: datetime
    status: str
    total_amount: float
    items: list[str] = []


class GetPastOrdersArgs(BaseModel):
    user_id: ObjectIdStr
    limit: int = Field(default=5, ge=1, le=20)


# ─── Step 2: semantic menu lookup ────────────────────────────

class MenuCandidate(BaseModel):
    item_id: str
    restaurant_id: str
    name: str
    category: str
    price: float
    score: float


class SearchMenuItemsArgs(BaseModel):
    user_id: ObjectIdStr
    query: str = Field(min_length=2, max_length=120)
    limit: int = Field(default=5, ge=1, le=10)


# ─── Step 3: cart mutation (strict — no free-text to the DB) ─

class LineItem(BaseModel):
    item_id: ObjectIdStr
    name: str
    unit_price: float = Field(ge=0)
    quantity: int = Field(ge=1, le=20)
    customizations: list[str] = []
    from_history: bool = False
    match_score: float | None = Field(default=None, ge=0, le=1)


class AddToCartArgs(BaseModel):
    user_id: ObjectIdStr
    restaurant_id: ObjectIdStr
    items: list[LineItem] = Field(min_length=1, max_length=25)


class UpdateCartArgs(BaseModel):
    user_id: ObjectIdStr
    restaurant_id: ObjectIdStr
    item_id: ObjectIdStr
    quantity: int = Field(ge=0, le=20)  # 0 = remove line


class SwapItemArgs(BaseModel):
    user_id: ObjectIdStr
    restaurant_id: ObjectIdStr
    remove_item_id: ObjectIdStr
    add_item_id: ObjectIdStr
    add_name: str
    add_price: float = Field(ge=0)
    add_quantity: int = Field(default=1, ge=1, le=20)
    customizations: list[str] = []
    reason: str = ""


# ─── Step 4: draft order state ───────────────────────────────

class PriceBreakdown(BaseModel):
    subtotal: float
    delivery_fee: float
    platform_fee: float
    total: float
    currency: str = "INR"


class CheckoutCard(BaseModel):
    """The structured UI contract the Next.js client renders."""

    restaurant_id: str
    restaurant_name: str
    lines: list[LineItem]
    pricing: PriceBreakdown
    requires_auth: bool = True  # explicit user confirmation before payment
    ready_to_pay: bool = False
    messages: list[str] = []


class DraftOrderState(BaseModel):
    session_id: str
    restaurant_id: str | None = None
    restaurant_name: str | None = None
    lines: list[LineItem] = []
    pricing: PriceBreakdown | None = None
    budget_cap: float | None = None
    budget_note: str | None = None
    constraints: dict[str, Any] = {}
    ready_to_pay: bool = False
    requires_auth: bool = True
    turn_count: int = 0
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class AgentTurnRequest(BaseModel):
    message: str = Field(min_length=1, max_length=1000)
    session_id: str | None = None  # None → new conversation


class AgentTurnResponse(BaseModel):
    session_id: str
    reply: str
    draft: DraftOrderState
    checkout_card: CheckoutCard | None = None
    tool_trace: list[dict[str, Any]] = []


# ─── Tool envelope ───────────────────────────────────────────

class ToolResult(BaseModel):
    tool: str
    ok: bool
    output: Any = None
    error: str | None = None
    duration_ms: int = 0
