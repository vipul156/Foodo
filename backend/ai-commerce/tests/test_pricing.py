"""Deterministic unit tests — pricing engine (pure Python, no I/O).

Run: pytest ai-commerce/tests -q
"""

from __future__ import annotations

import pytest

from app.schemas.commerce import LineItem
from app.services.pricing import compute_pricing


def _line(price: float, qty: int = 1) -> LineItem:
    return LineItem(
        item_id="a" * 24,
        name="Chicken Burger",
        unit_price=price,
        quantity=qty,
        customizations=[],
    )


class TestPricing:
    def test_under_threshold_adds_delivery_fee(self):
        # subtotal 2×99=198 < 250 → +49 delivery + 7 platform
        pricing = compute_pricing([_line(99, 2)])
        assert pricing.subtotal == 198.0
        assert pricing.delivery_fee == 49.0
        assert pricing.platform_fee == 7.0
        assert pricing.total == 254.0
        assert pricing.currency == "INR"

    def test_at_threshold_waives_delivery_fee(self):
        # subtotal exactly 250 → free delivery (rule: subtotal < 250 pays)
        pricing = compute_pricing([_line(125, 2)])
        assert pricing.subtotal == 250.0
        assert pricing.delivery_fee == 0.0
        assert pricing.total == 257.0

    def test_platform_fee_always_applies(self):
        pricing = compute_pricing([_line(499)])
        assert pricing.delivery_fee == 0.0
        assert pricing.total == 506.0

    def test_empty_cart_totals_zero(self):
        pricing = compute_pricing([])
        assert pricing.total == 0.0

    def test_float_drift_is_controlled(self):
        pricing = compute_pricing([_line(0.1, 3)])
        assert pricing.subtotal == pytest.approx(0.3, abs=0.01)

    def test_budget_boundary_examples(self):
        # The canonical demo: 2 chicken burgers @ 79 + swap fries→onion rings
        lines = [
            _line(79, 2),
            LineItem(item_id="b" * 24, name="Onion Rings", unit_price=90, quantity=1),
        ]
        pricing = compute_pricing(lines)
        assert pricing.subtotal == 248.0
        assert pricing.delivery_fee == 49.0
        assert pricing.total == 304.0  # over a $25/₹2000 budget → agent must trim
