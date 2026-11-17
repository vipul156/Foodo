"""Dispatch decision policy tests — the deterministic decide_node."""

from __future__ import annotations

import asyncio

from app.agents.dispatch_graph import decide_node
from app.core.config import get_settings
from app.schemas.dispatch import (
    BatchProposal,
    FleetSnapshot,
    OrderReadyEvent,
    RiderCandidate,
    WeatherReflex,
)

settings = get_settings()


def _event(order_id: str = "o" * 24) -> OrderReadyEvent:
    return OrderReadyEvent.model_validate(
        {
            "orderId": order_id,
            "restaurantId": "r" * 24,
            "location": {"type": "Point", "coordinates": [77.60, 12.96]},
        }
    )


def _state(**overrides) -> dict:
    base = {
        "event": _event(),
        "kitchen": {"predicted_prep_minutes": 18.0},
        "fleet": FleetSnapshot(candidates=[]),
        "weather": WeatherReflex(),
        "batch": None,
        "trace": [],
        "drop_coords": (13.05, 77.60),
    }
    base.update(overrides)
    return base


def test_no_candidates_broadcasts_with_surge():
    result = decide_node(_state())  # decide_node is a pure sync function
    decision = result["decision"]
    assert decision.broadcast is True
    assert decision.dispatch_mode == "broadcast"
    assert decision.surge_amount > 0
    assert decision.sla_risk == "high"


def test_best_candidate_assigned():
    fleet = FleetSnapshot(
        candidates=[
            RiderCandidate(
                rider_id="rider-1",
                rider_user_id="u1",
                name="Rider 1",
                location={"latitude": 12.97, "longitude": 77.60},
                distance_km=1.2,
            )
        ]
    )
    result = decide_node(_state(fleet=fleet))
    decision = result["decision"]
    assert decision.dispatch_mode == "assign"
    assert decision.assigned_rider_id == "rider-1"
    assert decision.mode == "single"
    assert decision.eta_minutes is not None


def test_batch_mode_flagged():
    fleet = FleetSnapshot(
        candidates=[
            RiderCandidate(
                rider_id="rider-1",
                rider_user_id="u1",
                name="Rider 1",
                location={"latitude": 12.97, "longitude": 77.60},
                distance_km=1.2,
            )
        ]
    )
    batch = BatchProposal(
        primary_order_id="o" * 24,
        secondary_order_id="b" * 24,
        primary_pickup={"latitude": 12.96, "longitude": 77.60},
        secondary_pickup={"latitude": 12.9605, "longitude": 77.6004},
        primary_dropoff={"latitude": 12.97, "longitude": 77.61},
        secondary_dropoff={"latitude": 12.972, "longitude": 77.612},
        delay_primary_s=120,
        delay_secondary_s=90,
        combined_distance_km=2.4,
    )
    result = decide_node(_state(fleet=fleet, batch=batch))
    decision = result["decision"]
    assert decision.mode == "batch"
    assert decision.batch.secondary_order_id == "b" * 24


def test_sla_risk_tiers():
    fleet = FleetSnapshot(
        candidates=[
            RiderCandidate(
                rider_id="x",
                rider_user_id="ux",
                name="X",
                location={"latitude": 12.97, "longitude": 77.60},
                distance_km=0.4,
            )
        ]
    )
    result = decide_node(_state(fleet=fleet))
    total = result["decision"].eta_minutes + 18.0
    expected = "low" if total < 30 else "medium" if total < 40 else "high"
    assert result["decision"].sla_risk == expected
