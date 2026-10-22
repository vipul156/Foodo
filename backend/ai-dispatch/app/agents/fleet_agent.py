"""Fleet State Agent — rider shortlist scoring.

Deterministic ranking of available riders for a given pickup→drop job:
  score = w_distance × proximity_term + w_heading × heading_term

Heading term aligns the rider's approach direction (rider → pickup) with
the delivery direction (pickup → drop) so the swarm prefers riders who
won't backtrack. Pure math — no LLM, no I/O; runs in microseconds for
candidate pools of hundreds.
"""

from __future__ import annotations

from pycommon.logging import get_logger

from app.schemas.dispatch import RiderCandidate
from app.services.geo import bearing_degrees, haversine_km

log = get_logger(__name__)

W_DISTANCE = 0.75
W_HEADING = 0.25


def _heading_alignment(rider: RiderCandidate, pickup: tuple[float, float], drop: tuple[float, float]) -> float:
    """1.0 = rider approaches the pickup from the delivery side (no backtrack)."""
    approach = bearing_degrees(
        rider.location.latitude, rider.location.longitude, pickup[0], pickup[1]
    )
    delivery = bearing_degrees(pickup[0], pickup[1], drop[0], drop[1])
    delta = abs(approach - delivery)
    if delta > 180:
        delta = 360 - delta
    return 1.0 - (delta / 180.0)  # 0 = opposite direction, 1 = same direction


def rank_candidates(
    candidates: list[RiderCandidate],
    pickup: tuple[float, float],
    drop: tuple[float, float],
) -> list[tuple[RiderCandidate, float]]:
    """Returns [(candidate, score)] sorted best-first. Score 0..1."""
    scored: list[tuple[RiderCandidate, float]] = []
    for candidate in candidates:
        proximity = max(
            0.0, 1.0 - candidate.distance_km / 10.0
        )  # 0 km → 1.0, 10 km → 0.0
        heading = _heading_alignment(candidate, pickup, drop)
        score = W_DISTANCE * proximity + W_HEADING * heading
        scored.append((candidate, round(score, 4)))
    scored.sort(key=lambda pair: pair[1], reverse=True)
    return scored


def eta_minutes(distance_km: float, pad_minutes: float = 0.0) -> float:
    """Rider travel ETA at ~25 km/h urban average + weather pad."""
    return round(distance_km * 2.4 + pad_minutes, 1)
