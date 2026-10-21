"""Batching / VRP-lite tests — geometry + SLA gates."""

from __future__ import annotations

from app.agents.batching_agent import evaluate_batch
from app.schemas.dispatch import BatchMember


def _member(order_id: str, plat: float, plng: float, dlat: float, dlng: float) -> BatchMember:
    return BatchMember(
        order_id=order_id,
        restaurant_id="r" * 24,
        pickup={"latitude": plat, "longitude": plng},
        dropoff={"latitude": dlat, "longitude": dlng},
    )


SAME_KITCHEN_A = (12.9600, 77.6000)
SAME_KITCHEN_B = (12.9605, 77.6004)  # ~60 m away
NEARBY_DROP_A = (12.9700, 77.6100)
NEARBY_DROP_B = (12.9720, 77.6120)   # ~270 m from drop A
FAR_DROP = (13.0500, 77.7000)        # ~10+ km away


def test_valid_pair_accepted():
    proposal = evaluate_batch(
        _member("A", *SAME_KITCHEN_A, *NEARBY_DROP_A),
        _member("B", *SAME_KITCHEN_B, *NEARBY_DROP_B),
        primary_prep_minutes=15,
        secondary_prep_minutes=15,
    )
    assert proposal is not None
    assert proposal.primary_order_id == "A"
    assert proposal.delay_primary_s <= 300


def test_far_drop_rejected():
    proposal = evaluate_batch(
        _member("A", *SAME_KITCHEN_A, *NEARBY_DROP_A),
        _member("B", *SAME_KITCHEN_B, *FAR_DROP),
        primary_prep_minutes=15,
        secondary_prep_minutes=15,
    )
    assert proposal is None


def test_far_pickup_rejected():
    proposal = evaluate_batch(
        _member("A", *SAME_KITCHEN_A, *NEARBY_DROP_A),
        _member("B", 13.1000, 77.9000, *NEARBY_DROP_B),
        primary_prep_minutes=15,
        secondary_prep_minutes=15,
    )
    assert proposal is None


def test_huge_sla_penalty_rejected():
    # Same kitchen, but drops on opposite sides of the city → detour busts SLA.
    proposal = evaluate_batch(
        _member("A", *SAME_KITCHEN_A, *NEARBY_DROP_A),
        _member("B", *SAME_KITCHEN_B, *FAR_DROP),
        primary_prep_minutes=0,
        secondary_prep_minutes=0,
    )
    assert proposal is None
