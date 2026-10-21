"""Dynamic Batching / VRP Agent (VRP-lite).

When a second order becomes ready within BATCH_RADIUS_M of the first's
pickup and its drop is within BATCH_DROP_RADIUS_M, the agent evaluates
the SLA trade-off: batching must not delay the primary order by more
than BATCH_SLA_PENALTY_S beyond its predicted ready time. The pairing is
a deterministic geometric + SLA computation — no LLM in this loop
(criterion is crisp; latency budget is milliseconds).
"""

from __future__ import annotations

from app.core.config import get_settings
from app.core.logging import get_logger
from app.schemas.dispatch import BatchMember, BatchProposal
from app.services.geo import haversine_km

log = get_logger(__name__)
settings = get_settings()


def evaluate_batch(
    primary: BatchMember,
    secondary: BatchMember,
    *,
    primary_prep_minutes: float,
    secondary_prep_minutes: float,
) -> BatchProposal | None:
    """Pure function — returns a validated proposal or None.

    Rules (all must hold):
      1. Pickups within batch_radius_m.
      2. Drops within batch_drop_radius_m (same neighborhood).
      3. The secondary's extra pickup detour must not push the PRIMARY's
         delivery beyond its SLA allowance (batch_sla_penalty_s).
      4. Secondary's delay is bounded by the same rule, symmetric.
    """
    pickup_gap = haversine_km(
        primary.pickup.latitude,
        primary.pickup.longitude,
        secondary.pickup.latitude,
        secondary.pickup.longitude,
    )
    if pickup_gap * 1000 > settings.batch_radius_m:
        return None

    drop_gap = haversine_km(
        primary.dropoff.latitude,
        primary.dropoff.longitude,
        secondary.dropoff.latitude,
        secondary.dropoff.longitude,
    )
    if drop_gap * 1000 > settings.batch_drop_radius_m:
        return None

    # Detour model (km → seconds at ~25 km/h urban average = 22 m/s … use
    # 0.15 min/km extra per stop conservatively in minutes):
    detour_minutes = (pickup_gap + drop_gap) * 2.5  # ~2.5 min per km of combined gap

    delay_primary = int(max(0.0, detour_minutes - primary_prep_minutes * 0.0) * 60)
    delay_secondary = int(max(0.0, detour_minutes * 0.6) * 60)

    if delay_primary > settings.batch_sla_penalty_s:
        return None
    if delay_secondary > settings.batch_sla_penalty_s:
        return None

    combined = pickup_gap + drop_gap
    return BatchProposal(
        primary_order_id=primary.order_id,
        secondary_order_id=secondary.order_id,
        primary_pickup=primary.pickup,
        secondary_pickup=secondary.pickup,
        primary_dropoff=primary.dropoff,
        secondary_dropoff=secondary.dropoff,
        delay_primary_s=delay_primary,
        delay_secondary_s=delay_secondary,
        combined_distance_km=round(combined, 3),
    )
