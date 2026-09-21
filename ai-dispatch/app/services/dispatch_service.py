"""Dispatch orchestrator — wires MQ events into the LangGraph swarm.

Responsibilities:
  - Consume order:ready_for_rider events (own fanout queue)
  - Enrich (items + drop coords), run the dispatch graph
  - Keep the batchable companion pool (Redis when configured, memory else)
  - Publish every decision to dispatch.events (fanout)
  - Expose stats/snapshot for the ops API

Idempotency: a Redis SETNX guard (TTL 60s) prevents double-dispatch when
the broker redelivers. Without Redis, an in-process guard gives single-pod
parity.
"""

from __future__ import annotations

import time
from typing import Any

from app.agents.dispatch_graph import dispatch_graph, build_graph
from app.clients.platform import PlatformClient
from app.core.config import get_settings
from app.core.logging import get_logger
from app.schemas.dispatch import DecisionEnvelope, DispatchHealth, OrderReadyEvent
from app.services.mq import MessageBus

log = get_logger(__name__)
settings = get_settings()

_IDEMPOTENCY_TTL_S = 60


class DispatchService:
    def __init__(self, platform: PlatformClient, bus: MessageBus, redis=None) -> None:
        self.platform = platform
        self.bus = bus
        self.redis = redis
        self._graph = build_graph()
        self._seen: dict[str, float] = {}
        self._pool: dict[str, dict[str, Any]] = {}  # batchable companion pool
        self.health = DispatchHealth()
        self._llm = None  # lazily built; None when unconfigured → heuristic-only

    # ─── MQ wiring ───────────────────────────────────────────

    async def handle_event(self, event: dict[str, Any]) -> None:
        """MessageBus handler — validates and dispatches one order event."""
        if not isinstance(event, dict) or event.get("type") != "order:ready_for_rider":
            return  # not ours (other event types ride the same fanout later)

        try:
            ready = OrderReadyEvent.model_validate(event.get("data") or {})
        except Exception as exc:  # noqa: BLE001 — invalid payloads go to the DLQ path
            raise ValueError(f"invalid order:ready_for_rider payload: {exc}") from exc

        order_id = ready.order_id
        if not await self._claim_idempotency(order_id):
            log.info("duplicate ready event ignored (order=%s)", order_id)
            return

        started = time.perf_counter()
        try:
            await self._dispatch(ready, started)
        except Exception:
            # Release the idempotency claim so a retry can reprocess.
            await self._release_idempotency(order_id)
            raise

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
        companions = await self.platform.get_batchable_orders(
            ready.restaurant_id, exclude_order_id=ready.order_id
        )
        pending_pool = [
            {
                "order_id": str(o.get("orderId", "")),
                "restaurant_id": str(o.get("restaurantId", "")),
                "pickup": o.get("pickup") or {},
                "dropoff": o.get("drop") or {},
                "prep_minutes": 15.0,  # conservative default for pool members
            }
            for o in companions
            if o.get("pickup") and o.get("drop")
        ]

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
        final = await self._graph.ainvoke(state, config={"recursion_limit": settings.max_graph_steps})
        decision = final["decision"]

        # ─── Outcome handling ────────────────────────────────────
        envelope = DecisionEnvelope(
            type="dispatch.decision",
            decision=decision,
            trace=final["trace"],
            at=time.time(),
        )
        await self.bus.publish_decision(envelope.model_dump(mode="json"))

        if decision.broadcast:
            self.health.broadcasts += 1
            # Nobody nearby: park the order in the pool so a LATER order
            # can pair with it (batching across time) and retry after the
            # surge cooloff.
            self._pool[ready.order_id] = {
                "order_id": ready.order_id,
                "restaurant_id": ready.restaurant_id,
                "pickup": {"latitude": ready.coords[0], "longitude": ready.coords[1]},
                "dropoff": (
                    {"latitude": drop[0], "longitude": drop[1]} if drop else {"latitude": ready.coords[0], "longitude": ready.coords[1]}
                ),
                "prep_minutes": final["kitchen"]["predicted_prep_minutes"],
                "parked_at": time.time(),
            }
        else:
            self.health.orders_dispatched += 1
            if decision.mode == "batch":
                self.health.batches_formed += 1
                # Remove the paired companion from the pool.
                if decision.batch:
                    self._pool.pop(decision.batch["secondary_order_id"], None)
            self._pool.pop(ready.order_id, None)

        log.info(
            "dispatched order=%s mode=%s rider=%s eta=%s in %dms",
            ready.order_id,
            decision.mode,
            decision.assigned_rider_id or "-",
            decision.eta_minutes,
            int((time.perf_counter() - started) * 1000),
        )

    # ─── Idempotency ─────────────────────────────────────────

    async def _claim_idempotency(self, order_id: str) -> bool:
        if self.redis is not None:
            key = f"dispatch:seen:{order_id}"
            return bool(await self.redis.set(key, "1", nx=True, ex=_IDEMPOTENCY_TTL_S))
        now = time.time()
        for stale_id, ts in list(self._seen.items()):
            if now - ts > _IDEMPOTENCY_TTL_S:
                del self._seen[stale_id]
        if order_id in self._seen:
            return False
        self._seen[order_id] = now
        return True

    async def _release_idempotency(self, order_id: str) -> None:
        if self.redis is not None:
            await self.redis.delete(f"dispatch:seen:{order_id}")
        else:
            self._seen.pop(order_id, None)

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
        return {
            "health": self.health.model_dump(),
            "pending_pool": list(self._pool.values()),
        }
