"""Unit tests — draft tool mutations (pure logic via ToolContext scratch)."""

from __future__ import annotations

import asyncio

import pytest

from app.agents.tools import (
    DraftAddInput,
    DraftFinalizeInput,
    DraftRemoveInput,
    DraftSetRestaurantInput,
    DraftSwapInput,
    DraftUpdateQtyInput,
    SearchMenuItemsInput,
    ToolContext,
    _draft_add_item,
    _draft_finalize,
    _draft_remove_item,
    _draft_set_restaurant,
    _draft_swap_item,
    _draft_update_quantity,
)
from app.clients.platform import PlatformClient


def _ctx() -> ToolContext:
    return ToolContext(user_id="u" * 24, cookie_header="session=x", platform=PlatformClient())


def test_add_and_finalize():
    ctx = _ctx()

    async def run():
        await _draft_add_item(DraftAddInput(item_id="a" * 24, name="Burger", unit_price=79, quantity=2), ctx)
        result = await _draft_finalize(DraftFinalizeInput(budget_cap=500), ctx)
        assert result["ok"] and result["pricing"]["total"] == 214.0  # 158 + 49 delivery + 7 platform
        assert result["over_budget"] is False

    asyncio.run(run())


def test_swap_replaces_line():
    ctx = _ctx()

    async def run():
        await _draft_add_item(DraftAddInput(item_id="a" * 24, name="Fries", unit_price=70), ctx)
        result = await _draft_swap_item(
            DraftSwapInput(remove_item_id="a" * 24, add_item_id="b" * 24, add_name="Onion Rings", add_unit_price=90),
            ctx,
        )
        assert result["removed"] is True
        assert ctx.scratch["draft"]["lines"][0]["name"] == "Onion Rings"

    asyncio.run(run())


def test_restaurant_switch_clears_draft():
    ctx = _ctx()

    async def run():
        await _draft_set_restaurant(DraftSetRestaurantInput(restaurant_id="r" * 24, restaurant_name="Burger Barn"), ctx)
        await _draft_add_item(DraftAddInput(item_id="a" * 24, name="Fries", unit_price=70), ctx)
        result = await _draft_set_restaurant(DraftSetRestaurantInput(restaurant_id="r2" * 24, restaurant_name="Other"), ctx)
        assert result["cleared_lines"] is True
        assert ctx.scratch["draft"]["lines"] == []

    asyncio.run(run())


def test_budget_guard_flags_over_budget():
    ctx = _ctx()

    async def run():
        await _draft_add_item(DraftAddInput(item_id="a" * 24, name="Biryani", unit_price=400, quantity=2), ctx)
        result = await _draft_finalize(DraftFinalizeInput(budget_cap=25), ctx)
        assert result["over_budget"] is True

    asyncio.run(run())


def test_remove_missing_item_reports_not_removed():
    ctx = _ctx()

    async def run():
        result = await _draft_remove_item(DraftRemoveInput(item_id="zz" * 12), ctx)
        assert result["removed"] is False

    asyncio.run(run())


def test_quantity_zero_removes_line():
    ctx = _ctx()

    async def run():
        await _draft_add_item(DraftAddInput(item_id="a" * 24, name="Fries", unit_price=70, quantity=2), ctx)
        result = await _draft_update_quantity(DraftUpdateQtyInput(item_id="a" * 24, quantity=0), ctx)
        assert result["ok"] and ctx.scratch["draft"]["lines"] == []

    asyncio.run(run())
