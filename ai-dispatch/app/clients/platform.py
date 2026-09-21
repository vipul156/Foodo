"""Breaker-wrapped internal clients to platform services.

All calls carry x-internal-key; identity and authorization stay with the
domain-owning service. Every failure degrades — the swarm never crashes
on a sibling outage, it dispatches with reduced information and says so
in the decision trace.
"""

from __future__ import annotations

from typing import Any

from app.core.config import get_settings
from app.core.logging import get_logger
from app.core.resilience import BreakerOpen, call_with_resilience, internal_get, internal_post, pools
from app.schemas.dispatch import FleetSnapshot, RiderCandidate

log = get_logger(__name__)
settings = get_settings()


class PlatformClient:
    async def get_kitchen_state(self, restaurant_id: str) -> dict[str, Any]:
        """Active kitchen queue for prep prediction.

        Uses the restaurant's order stats (global active count) as a
        proxy for queue depth when the per-restaurant counter is
        unavailable. Returns {} on any failure (degraded prediction).
        """
        try:
            data = await internal_get(
                f"{settings.restaurant_service_url}/api/internal/restaurants/stats",
                headers={"x-internal-key": settings.internal_service_key},
            )
            return {"active_orders": int(data.get("active", 0)), "global": True}
        except (BreakerOpen, Exception) as exc:  # noqa: BLE001
            log.warning("kitchen state unavailable: %s", exc)
            return {}

    async def get_order_summary(self, order_id: str) -> dict[str, Any] | None:
        """Order enrichment: item names + drop coordinates (internal-key)."""
        try:
            data = await internal_get(
                f"{settings.restaurant_service_url}/api/internal/orders/{order_id}/summary",
                headers={"x-internal-key": settings.internal_service_key},
            )
            return (data or {}).get("summary")
        except (BreakerOpen, Exception) as exc:  # noqa: BLE001
            log.warning("order summary unavailable: %s", exc)
            return None

    async def get_batchable_orders(self, restaurant_id: str, exclude_order_id: str) -> list[dict[str, Any]]:
        """Companion-order pool for the batching agent (internal-key)."""
        try:
            data = await internal_get(
                f"{settings.restaurant_service_url}/api/internal/orders/batchable",
                params={
                    "restaurantId": restaurant_id,
                    "excludeOrderId": exclude_order_id,
                },
                headers={"x-internal-key": settings.internal_service_key},
            )
            return (data or {}).get("orders", []) if isinstance(data, dict) else []
        except (BreakerOpen, Exception) as exc:  # noqa: BLE001
            log.warning("batchable pool unavailable: %s", exc)
            return []

    async def get_nearby_riders(self, latitude: float, longitude: float) -> FleetSnapshot:
        """Available riders near a pickup point.

        Uses the rider service's internal roster and filters by distance
        locally (the roster is small; $near semantics without a bound are
        avoided intentionally to keep the swarm's radius policy in one
        place).
        """
        try:
            data = await internal_get(
                f"{settings.rider_service_url}/api/internal/riders",
                headers={"x-internal-key": settings.internal_service_key},
            )
            riders = data.get("riders", []) if isinstance(data, dict) else []
            candidates: list[RiderCandidate] = []
            for rider in riders:
                if not rider.get("isAvailable") or not rider.get("isVerified"):
                    continue
                location = rider.get("location") or {}
                coords = location.get("coordinates") or [0, 0]
                r_lng, r_lat = float(coords[0]), float(coords[1])
                from app.services.geo import haversine_km

                distance = haversine_km(latitude, longitude, r_lat, r_lng)
                if distance <= settings.rider_search_radius_km:
                    candidates.append(
                        RiderCandidate(
                            rider_id=str(rider["_id"]),
                            rider_user_id=str(rider.get("userId", "")),
                            name=str(rider.get("name", "Delivery Partner")),
                            phone=str(rider.get("phoneNumber")) if rider.get("phoneNumber") else None,
                            picture=rider.get("picture"),
                            location={"latitude": r_lat, "longitude": r_lng},
                            distance_km=round(distance, 3),
                        )
                    )
            candidates.sort(key=lambda c: c.distance_km)
            return FleetSnapshot(candidates=candidates[: settings.max_candidates])
        except BreakerOpen as exc:
            log.error("rider roster breaker open")
            return FleetSnapshot(candidates=[], degraded=True)
        except Exception as exc:  # noqa: BLE001
            log.warning("rider roster unavailable: %s", exc)
            return FleetSnapshot(candidates=[], degraded=True)

    async def emit_realtime(self, event: str, room: str, payload: Any) -> None:
        """Push to a socket room through the realtime service (fire-and-forget)."""
        try:
            await internal_post(
                f"{settings.realtime_service_url}/api/internal/emit",
                json_body={"event": event, "room": room, "payload": payload},
                headers={"x-internal-key": settings.internal_service_key},
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("realtime emit failed (%s → %s): %s", event, room, exc)

    async def notify_riders_broadcast(self, order_id: str, restaurant_id: str, rider_user_ids: list[str], surge: float = 0.0) -> int:
        """Broadcast an availability offer to N riders' socket rooms."""
        delivered = 0
        for user_id in rider_user_ids:
            await self.emit_realtime(
                "order:available",
                f"user:{user_id}",
                {
                    "orderId": order_id,
                    "restaurantId": restaurant_id,
                    "dispatch": "broadcast",
                    "surgeIncentive": surge,
                },
            )
            delivered += 1
        return delivered

    async def create_order(self, order_id: str, rider_id: str, batch: dict | None = None) -> bool:
        """Reserved seam: push-assignment claim via an internal endpoint.

        The platform's assignment path is rider-claim today (acceptOrder →
        rider.order_accepted → restaurant assignRiderToOrder). A push-mode
        assignment endpoint on the rider/restaurant services is the
        integration seam — documented in the design doc; until it exists,
        the swarm drives assignment via targeted broadcasts and publishes
        its decision for observability.
        """
        log.info("push-assignment seam called (order=%s rider=%s batch=%s)", order_id, rider_id, bool(batch))
        return False
