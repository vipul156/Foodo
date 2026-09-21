"""Deterministic pricing — the LLM NEVER computes money.

Fee rules are copied 1:1 from the restaurant service's createOrder
(deliveryFee = 49 if subtotal < 250 else 0; platformFee = 7; total =
subtotal + deliveryFee + platformFee). If the platform's fee rules ever
change, they must change in BOTH places — enforced by a shared test that
documents the coupling.

All arithmetic is Decimal-based (no float drift), then rounded to 2dp.
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal

from app.schemas.commerce import LineItem, PriceBreakdown

DELIVERY_FEE_THRESHOLD = Decimal("250")
DELIVERY_FEE = Decimal("49")
PLATFORM_FEE = Decimal("7")
CURRENCY = "INR"


def _money(value: Decimal) -> float:
    return float(value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def compute_pricing(lines: list[LineItem]) -> PriceBreakdown:
    subtotal = sum(
        (Decimal(str(line.unit_price)) * line.quantity for line in lines),
        Decimal("0"),
    )
    if subtotal <= 0:
        # Empty draft: nothing to charge — zero fees, not a minimum order.
        return PriceBreakdown(
            subtotal=0.0,
            delivery_fee=0.0,
            platform_fee=0.0,
            total=0.0,
            currency=CURRENCY,
        )
    delivery_fee = DELIVERY_FEE if subtotal < DELIVERY_FEE_THRESHOLD else Decimal("0")
    total = subtotal + delivery_fee + PLATFORM_FEE
    return PriceBreakdown(
        subtotal=_money(subtotal),
        delivery_fee=_money(delivery_fee),
        platform_fee=_money(PLATFORM_FEE),
        total=_money(total),
        currency=CURRENCY,
    )
