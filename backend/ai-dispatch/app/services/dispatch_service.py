"""Dispatch orchestrator — wires the SQS intake into the LangGraph swarm.

Responsibilities:
  - Consume order:ready_for_rider payloads from the dispatch consumer
  - Enrich (item names + drop coords), run the dispatch graph
  - Keep the batchable companion pool in DynamoDB: in-memory state dies
    with a warm container, and cross-time batching needs a shared pool
  - Publish every decision to SNS (dispatch.decision)
  - Expose stats/snapshot for the ops API

Idempotency: the SQS source is at-least-once, so a ready-event claim row
(conditional PutItem with a TTL) prevents double-dispatch on redelivery.
A failed graph run releases the claim so the retry can reprocess.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any

from pycommon.aws import from_dynamo, table, to_dynamo
from pycommon.logging import get_logger

from app.agents.dispatch_graph import build_graph
from app.clients.platform import PlatformClient
from app.core.config import get_settings
from app.schemas.dispatch import DecisionEnvelope, DispatchHealth, OrderReadyEvent
from app.services.events import publish_decision

log = get_logger(__name__)
settings = get_settings()

_STATE_TABLE = ("DISPATCH_STATE_TABLE", "foodo-dispatch-state")

# Pool rows parked for co-location batching later.
_POOL_KEY_MAX = 400  # safety cap on companions considered per restaurant


def _state():
    return table(*_STATE_TABLE)


def _iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class DispatchService:
    def __init__(self, platform: PlatformClient) -> None:
        self.platform = platform
        self._graph = build_graph()
        self._llm = None  # lazily built; None when unconfigured → heuristic-only
        self.health = DispatchHealth()

    # ─── Intake ──────────────────────────────────────────────

    async def handle_event(self, payload: dict[str, Any]) -> None:
        """Consumer entrypoint — validates and dispatches one ready order.

        Accepts either the raw ready payload ({orderId, restaurantId,
        location}) or the legacy envelope ({type: 'order:ready_for_rider',
        data: {...}}) so staging tooling keeps working.
        """
        ready_payload = payload
        if isinstance(payload, dict) and "type" in payload and "data" in payload:
            if payload.get("type") != "order:ready_for_rider":
                return  # not ours (other events ride the same topic)
            ready_payload = payload.get("data") or {}

        try:
            ready = OrderReadyEvent.model_validate(ready_payload or {})
        except Exception as exc:  # noqa: BLE001 — invalid payloads go to redrive
            raise ValueError(f"invalid order:ready_for_rider payload: {exc}") from exc

        if not self._claim(ready.order_id):
            log.info("duplicate ready event ignored (order=%s)", ready.order_id)
            return

        started = time.perf_counter()
        try:
            await self._dispatch(ready, started)
        except Exception:
            self._release(ready.order_id)
            raise

    # ─── The dispatch run ────────────────────────────────────

    async def _dispatch(self, ready: OrderReadyEvent, started: float) -> None:
        # ─── Enrichment: item names + drop coordinates ───────────
        summary = await self.platform.get_order_summary(ready.order_id)
        item_names = (
            [str(i.get("name", "")) for i in (summary or {}).get("items", [])]
            if summary
            else []
        )
        drop = None
        if summary and summary.get("drop") and summary["drop"].get("latitude") is not None:
            drop = (float(summary["drop"]["latitude"]), float(summary["drop"]["longitude"]))

        # ─── Batching pool: companions at the same restaurant ────
        pending_pool = await self._pop_pool_candidates(ready.restaurant_id, ready.order_id)

        # ─── Graph ───────────────────────────────────────────────
        state = {
            "event": ready,
            "platform": self.platform,
            "llm": self._get_llm(),
            "item_names": item_names,
            "drop_coords": drop,
            "pending_pool": pending_pool,
            "kitchen": {"predicted_prep_minutes": settings.prep_base_minutes},
            "fleet": {"candidates": [], "degraded": False},
            "weather": {"pad_minutes": 0.0, "surge_bump": 0.0, "degraded": True},
            "batch": None,
            "decision": None,
            "trace": [],
            "errors": [],
        }
        final = await self._graph.ainvoke(
            state, config={"recursion_limit": settings.max_graph_steps}
        )
        decision = final["decision"]

        # ─── Outcome handling ────────────────────────────────────
        envelope = DecisionEnvelope(
            type="dispatch.decision",
            decision=decision,
            trace=final["trace"],
            at=time.time(),
        )
        publish_decision(envelope.model_dump(mode="json"))

        if decision.broadcast:
            self.health.broadcasts += 1
            # Nobody nearby: park the order in the pool so a LATER order
            # can pair with it (batching across time) and retry after the
            # surge cooloff.
            dropoff = (
                {"latitude": drop[0], "longitude": drop[1]}
                if drop
                else {"latitude": ready.coords[0], "longitude": ready.coords[1]}
            )
            self._put_pool_row(
                {
                    "order_id": ready.order_id,
                    "restaurant_id": ready.restaurant_id,
                    "pickup": {"latitude": ready.coords[0], "longitude": ready.coords[1]},
                    "dropoff": dropoff,
                    "prep_minutes": float(final["kitchen"]["predicted_prep_minutes"]),
                    "parked_at": time.time(),
                    # MUST be `expiresAt` — that is the attribute the IaC
                    # enables DynamoDB's TTL sweep on. A row keyed by any
                    # other name is never swept and the pool grows forever.
                    "expiresAt": int(time.time()) + settings.pool_ttl_s,
                }
            )
        else:
            self.health.orders_dispatched += 1
            if decision.mode == "batch":
                self.health.batches_formed += 1
                # Remove the paired companion from the pool.
                if decision.batch:
                    self._delete_pool_row(
                        ready.restaurant_id, decision.batch.secondary_order_id
                    )

        log.info(
            "dispatched order=%s mode=%s rider=%s eta=%s in %dms",
            ready.order_id,
            decision.mode,
            decision.assigned_rider_id or "-",
            decision.eta_minutes,
            int((time.perf_counter() - started) * 1000),
        )

    # ─── Idempotency (DynamoDB claims with TTL) ──────────────

    def _claim(self, order_id: str) -> bool:
        """Conditional PutItem — wins exactly once across all containers."""
        try:
            _state().put_item(
                Item={
                    "pk": f"READY#{order_id}",
                    "sk": "SEEN",
                    "claimedAt": _iso(),
                    "expiresAt": int(time.time()) + settings.idempotency_ttl_s,
                },
                ConditionExpression="attribute_not_exists(pk)",
            )
            return True
        except _state().meta.client.exceptions.ConditionalCheckFailedException:
            return False

    def _release(self, order_id: str) -> None:
        """Drop the claim so a redelivered event can reprocess."""
        try:
            _state().delete_item(Key={"pk": f"READY#{order_id}", "sk": "SEEN"})
        except Exception as exc:  # noqa: BLE001
            log.warning("claim release failed (order=%s): %s", order_id, exc)

    # ─── Pending pool (DynamoDB rows, TTL-swept) ─────────────

    async def _pop_pool_candidates(self, restaurant_id: str, exclude_order_id: str) -> list[dict[str, Any]]:
        """Companion orders parked at the same restaurant (batching pool)."""
        try:
            response = _state().query(
                KeyConditionExpression="pk = :pool",
                # DynamoDB's TTL sweep is lazy (up to 48h), so an expired
                # row can still be returned — filter it out here rather
                # than batching a companion that has already timed out.
                FilterExpression="attribute_not_exists(expiresAt) OR expiresAt > :now",
                ExpressionAttributeValues={
                    ":pool": f"POOL#{restaurant_id}",
                    ":now": int(time.time()),
                },
                Limit=_POOL_KEY_MAX,
            )
            return [
                {
                    "order_id": row["order_id"],
                    "restaurant_id": restaurant_id,
                    "pickup": row.get("pickup") or {},
                    "dropoff": row.get("dropoff") or {},
                    "prep_minutes": float(row.get("prep_minutes", 15.0)),
                }
                for row in from_dynamo(response.get("Items", []))
                if row.get("order_id") != exclude_order_id
            ]
        except Exception as exc:  # noqa: BLE001
            log.warning("pool unavailable (batching degraded): %s", exc)
            return []

    def _put_pool_row(self, row: dict[str, Any]) -> None:
        try:
            # The row carries coordinates and prep minutes — floats, which
            # DynamoDB refuses (it has no float type). Without the cast
            # the write fails and the pool silently stays EMPTY, so
            # cross-time batching never happens.
            _state().put_item(
                Item=to_dynamo(
                    {
                        "pk": f"POOL#{row['restaurant_id']}",
                        "sk": f"ORDER#{row['order_id']}",
                        **row,
                        "updatedAt": _iso(),
                    }
                )
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("pool put failed (order=%s): %s", row.get("order_id"), exc)

    def _delete_pool_row(self, restaurant_id: str, order_id: str) -> None:
        try:
            _state().delete_item(
                Key={"pk": f"POOL#{restaurant_id}", "sk": f"ORDER#{order_id}"}
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("pool delete failed (order=%s): %s", order_id, exc)

    # ─── LLM (kitchen refinement only) ───────────────────────

    def _get_llm(self):
        if self._llm is None and settings.anthropic_api_key:
            from langchain_anthropic import ChatAnthropic

            self._llm = ChatAnthropic(
                model=settings.anthropic_model,
                api_key=settings.anthropic_api_key,
                temperature=0,
                max_tokens=settings.llm_max_tokens,
                timeout=settings.llm_timeout_s,
            )
        return self._llm

    # ─── Ops surface ─────────────────────────────────────────

    def snapshot(self) -> dict[str, Any]:
        pool_rows: list[dict[str, Any]] = []
        try:
            response = _state().scan(
                FilterExpression=(
                    "begins_with(pk, :pool) AND "
                    "(attribute_not_exists(expiresAt) OR expiresAt > :now)"
                ),
                ExpressionAttributeValues={
                    ":pool": "POOL#",
                    ":now": int(time.time()),
                },
                Limit=100,
            )
            pool_rows = [
                {
                    "order_id": row.get("order_id"),
                    "restaurant_id": row.get("restaurant_id"),
                    "pickup": row.get("pickup"),
                    "dropoff": row.get("dropoff"),
                    "prep_minutes": row.get("prep_minutes"),
                    "parked_at": row.get("parked_at"),
                }
                for row in from_dynamo(response.get("Items", []))
            ]
        except Exception as exc:  # noqa: BLE001
            log.warning("pool snapshot unavailable: %s", exc)
        return {"health": self.health.model_dump(), "pending_pool": pool_rows}


_service: DispatchService | None = None


def get_service() -> DispatchService:
    """Warm-container singleton — one graph + client set per Lambda env."""
    global _service
    if _service is None:
        _service = DispatchService(PlatformClient())
    return _service
