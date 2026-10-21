"""Breaker-wrapped platform access for the dispatch swarm.

Order enrichment and the rider roster now come straight from the shared
DynamoDB tables (ORDERS_TABLE / RIDERS_TABLE, injected by IaC): the
legacy internal-only endpoints they used to proxy do not exist on the
serverless services, and reading the domain owner's table directly keeps
one round-trip instead of three. Realtime emission stays HTTP (the
realtime service owns socket fanout).

Every failure degrades — the swarm never crashes on a sibling outage;
it dispatches with reduced information and says so in the decision
trace.
"""

from __future__ import annotations

from typing import Any

from pycommon.aws import table

from app.core.config import get_settings
from app.core.logging import get_logger
from app.core.resilience import (
    BreakerOpen,
    call_with_resilience,
    internal_get,
    internal_post,
)
from app.schemas.dispatch import FleetSnapshot, RiderCandidate
from app.services.geo import haversine_km

log = get_logger(__name__)
settings = get_settings()


def _orders_table():
    return table("ORDERS_TABLE", "foodo-orders")


def _riders_table():
    return table("RIDERS_TABLE", "foodo-riders")


class PlatformClient:
    async def get_kitchen_state(self, restaurant_id: str) -> dict[str, Any]:
        """Active kitchen queue for prep prediction.

        Uses the restaurant's global stats endpoint as a proxy for queue
        depth. Returns {} on any failure (degraded prediction).
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
        """Order enrichment from the orders table: item names + drop."""
        try:
            item = _orders_table().get_item(Key={"pk": f"ORDER#{order_id}", "sk": "ORDER"}).get("Item")
            if not item:
                return None
            drop = item.get("deliveryAddress") or {}
            return {
                "items": [
                    {"name": i.get("name", ""), "quantity": i.get("quantity", 1)}
                    for i in (item.get("items") or [])
                ],
                "drop": {
                    "latitude": drop.get("latitude"),
                    "longitude": drop.get("longitude"),
                    "formattedAddress": drop.get("formattedAddress"),
                },
                "restaurantId": item.get("restaurantId"),
                "status": item.get("status"),
            }
        except Exception as exc:  # noqa: BLE001
            log.warning("order summary unavailable: %s", exc)
            return None

    async def get_nearby_riders(self, latitude: float, longitude: float) -> FleetSnapshot:
        """Available riders near a pickup point, from the riders table.

        Direct Scan with a cheap availability filter (the roster is
        small); distance ranking is local so the swarm's radius policy
        stays in one place. DynamoDB is sync — acceptable inside the
        async graph (sub-10ms single-digit-GB scans are the wrong worry
        for a LangGraph node).
        """
        try:
            from boto3.dynamodb.conditions import Attr

            response = _riders_table().scan(
                FilterExpression=Attr("isAvailable").eq(True) & Attr("isVerified").eq(True),
            )
            candidates: list[RiderCandidate] = []
            for rider in response.get("Items", []):
                location = rider.get("location") or {}
                coords = location.get("coordinates") or [0, 0]
                r_lng, r_lat = float(coords[0]), float(coords[1])
                distance = haversine_km(latitude, longitude, r_lat, r_lng)
                if distance <= settings.rider_search_radius_km:
                    candidates.append(
                        RiderCandidate(
                            rider_id=str(rider.get("id", "")),
                            rider_user_id=str(rider.get("userId", "")),
                            name=str(rider.get("name", "Delivery Partner")),
                            phone=str(rider["phoneNumber"]) if rider.get("phoneNumber") else None,
                            picture=rider.get("picture"),
                            location={"latitude": r_lat, "longitude": r_lng},
                            distance_km=round(distance, 3),
                        )
                    )
            candidates.sort(key=lambda c: c.distance_km)
            return FleetSnapshot(candidates=candidates[: settings.max_candidates])
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

    async def notify_riders_broadcast(
        self,
        order_id: str,
        restaurant_id: str,
        rider_user_ids: list[str],
        surge: float = 0.0,
    ) -> int:
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

    async def create_order(
        self, order_id: str, rider_id: str, batch: dict | None = None
    ) -> bool:
        """Reserved seam: push-assignment claim via an internal endpoint.

        The platform's assignment path is rider-claim today (acceptOrder →
        rider.order_accepted → restaurant assignRider). Until a push-mode
        endpoint ships, the swarm drives assignment via targeted
        broadcasts and publishes its decision for observability.
        """
        log.info(
            "push-assignment seam called (order=%s rider=%s batch=%s)",
            order_id,
            rider_id,
            bool(batch),
        )
        return False
