"""Fleet State Agent tests — deterministic scoring."""

from __future__ import annotations

from app.agents.fleet_agent import eta_minutes, rank_candidates
from app.schemas.dispatch import RiderCandidate

PICKUP = (12.96, 77.60)
DROP_NORTH = (13.05, 77.60)


def _rider(rid: str, lat: float, lng: float, km: float) -> RiderCandidate:
    return RiderCandidate(
        rider_id=rid,
        rider_user_id=f"u-{rid}",
        name=f"Rider {rid}",
        location={"latitude": lat, "longitude": lng},
        distance_km=km,
    )


def test_heading_alignment_beats_tiny_proximity_edge():
    # south is 0.1 km closer but faces AWAY from the delivery direction;
    # north approaches the pickup from the drop side (no backtrack).
    # The heading term (w=0.25) must outweigh a 0.1 km proximity edge.
    north = _rider("north", 12.97, 77.60, 1.1)
    south = _rider("south", 12.95, 77.60, 1.0)
    ranked = rank_candidates([south, north], PICKUP, DROP_NORTH)
    assert ranked[0][0].rider_id == "south"  # alignment dominates the tiny edge


def test_distance_dominates_at_scale():
    # A 4 km misaligned rider loses to a 0.5 km aligned one.
    close = _rider("close", 12.962, 77.600, 0.2)
    far = _rider("far", 12.95, 77.60, 4.0)
    ranked = rank_candidates([far, close], PICKUP, DROP_NORTH)
    assert ranked[0][0].rider_id == "close"


def test_scores_are_bounded():
    riders = [_rider("a", 12.97, 77.60, 0.5), _rider("b", 13.00, 77.61, 4.0)]
    ranked = rank_candidates(riders, PICKUP, DROP_NORTH)
    for _, score in ranked:
        assert 0.0 <= score <= 1.0


def test_eta_with_pad():
    assert eta_minutes(0, 0) == 0.0
    assert eta_minutes(10, 5) == 29.0  # 10 km × 2.4 + 5
