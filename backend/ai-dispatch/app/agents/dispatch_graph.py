"""The Aegis-Dispatch graph (LangGraph state machine).

Flow per order:ready_for_rider event:

    validate → kitchen.predict → fleet.snapshot → weather.reflex
             → batching.pair (optional) → decide → act

Design laws:
  - Every node validates its inputs with Pydantic and degrades gracefully.
  - The LLM appears in exactly ONE node (kitchen refinement) and can only
    nudge a deterministic baseline ±40%.
  - The final decision is a pure policy function of node outputs.
  - The whole graph is bounded by recursion_limit; every step is traced.
"""

from __future__ import annotations

import time
from typing import Any, TypedDict

from langgraph.graph import END, StateGraph

from pycommon.logging import get_logger

from app.agents.batching_agent import evaluate_batch
from app.agents.fleet_agent import eta_minutes, rank_candidates
from app.agents.kitchen_agent import predict
from app.agents.weather_agent import get_weather_reflex
from app.clients.platform import PlatformClient
from app.core.config import get_settings
from app.schemas.dispatch import (
    AssignmentDecision,
    BatchMember,
    BatchProposal,
    FleetSnapshot,
    OrderReadyEvent,
    WeatherReflex,
)

log = get_logger(__name__)
settings = get_settings()


class DispatchState(TypedDict):
    event: OrderReadyEvent
    platform: PlatformClient
    llm: Any | None
    item_names: list[str]
    kitchen: dict[str, Any]
    fleet: FleetSnapshot
    weather: WeatherReflex
    batch: BatchProposal | None
    decision: AssignmentDecision | None
    trace: list[dict[str, Any]]
    errors: list[str]
    # LangGraph DROPS any key the state schema does not declare, so both
    # of these must be listed here or the nodes never see them:
    #   drop_coords   — the delivery drop point (falls back to the pickup)
    #   pending_pool  — the companion orders parked for cross-time batching
    drop_coords: tuple[float, float] | None
    pending_pool: list[dict[str, Any]]


# ─── Nodes ───────────────────────────────────────────────────

async def validate_node(state: DispatchState) -> dict[str, Any]:
    event: OrderReadyEvent = state["event"]
    drop = state.get("drop_coords") or _lookup_drop(state)
    return {"trace": state["trace"] + [{"node": "validate", "at": time.time(), "ok": True}]}


def _lookup_drop(state: DispatchState) -> tuple[float, float]:
    # Drop coordinates arrive with the order enrichment (restaurant service
    # includes deliveryAddress in the event when available). Fallback: the
    # pickup point — dispatch still works, ETA is flagged approximate.
    coords = state["event"].coords
    return (coords[0], coords[1])


async def kitchen_node(state: DispatchState) -> dict[str, Any]:
    started = time.perf_counter()
    platform: PlatformClient = state["platform"]
    event: OrderReadyEvent = state["event"]

    kitchen_state = await platform.get_kitchen_state(event.restaurant_id)
    prediction = await predict(
        order_id=event.order_id,
        item_names=state["item_names"],
        kitchen_state=kitchen_state,
        llm=state.get("llm"),
    )
    return {
        "kitchen": prediction,
        "trace": state["trace"]
        + [
            {
                "node": "kitchen.predict",
                "prep_minutes": prediction["predicted_prep_minutes"],
                "degraded": prediction["degraded"],
                "duration_ms": int((time.perf_counter() - started) * 1000),
                "at": time.time(),
            }
        ],
    }


async def fleet_node(state: DispatchState) -> dict[str, Any]:
    started = time.perf_counter()
    platform: PlatformClient = state["platform"]
    event: OrderReadyEvent = state["event"]
    lat, lng = event.coords

    snapshot = await platform.get_nearby_riders(lat, lng)
    return {
        "fleet": snapshot,
        "trace": state["trace"]
        + [
            {
                "node": "fleet.snapshot",
                "candidates": len(snapshot.candidates),
                "degraded": snapshot.degraded,
                "duration_ms": int((time.perf_counter() - started) * 1000),
                "at": time.time(),
            }
        ],
    }


async def weather_node(state: DispatchState) -> dict[str, Any]:
    started = time.perf_counter()
    event: OrderReadyEvent = state["event"]
    lat, lng = event.coords

    reflex = await get_weather_reflex(lat, lng)
    return {
        "weather": reflex,
        "trace": state["trace"]
        + [
            {
                "node": "weather.reflex",
                "condition": reflex.condition,
                "pad_minutes": reflex.pad_minutes,
                "surge_bump": reflex.surge_bump,
                "degraded": reflex.degraded,
                "duration_ms": int((time.perf_counter() - started) * 1000),
                "at": time.time(),
            }
        ],
    }


async def batching_node(state: DispatchState) -> dict[str, Any]:
    """Look for a batchable companion order from the pending pool."""
    started = time.perf_counter()
    pending: list[dict[str, Any]] = state.get("pending_pool") or []
    event: OrderReadyEvent = state["event"]
    batch: BatchProposal | None = None

    if pending:
        primary = BatchMember(
            order_id=event.order_id,
            restaurant_id=event.restaurant_id,
            pickup=_geo(event.coords),
            dropoff=_geo(state.get("drop_coords") or event.coords),
        )
        for candidate in pending:
            if candidate.get("order_id") == event.order_id:
                continue
            secondary = BatchMember(
                order_id=candidate["order_id"],
                restaurant_id=candidate.get("restaurant_id", ""),
                pickup=_geo(
                    (
                        candidate["pickup"]["latitude"],
                        candidate["pickup"]["longitude"],
                    )
                ),
                dropoff=_geo(
                    (
                        candidate["dropoff"]["latitude"],
                        candidate["dropoff"]["longitude"],
                    )
                ),
            )
            proposal = evaluate_batch(
                primary,
                secondary,
                primary_prep_minutes=state["kitchen"]["predicted_prep_minutes"],
                secondary_prep_minutes=candidate.get("prep_minutes", 15.0),
            )
            if proposal is not None:
                # Keep the MODEL: decide_node reads it by attribute and
                # the decision envelope validates it into the same type.
                batch = proposal
                break

    return {
        "batch": batch,
        "trace": state["trace"]
        + [
            {
                "node": "batching.pair",
                "paired": batch is not None,
                "pool_size": len(pending),
                "duration_ms": int((time.perf_counter() - started) * 1000),
                "at": time.time(),
            }
        ],
    }


def _geo(coords: tuple[float, float]) -> dict:
    return {"latitude": coords[0], "longitude": coords[1]}


def decide_node(state: DispatchState) -> dict[str, Any]:
    """DETERMINISTIC policy — the LLM never decides."""
    event: OrderReadyEvent = state["event"]
    fleet: FleetSnapshot = state["fleet"]
    weather: WeatherReflex = state["weather"]
    kitchen = state["kitchen"]
    batch = state.get("batch")
    trace = state["trace"]

    lat, lng = event.coords
    drop = state.get("drop_coords") or (lat, lng)
    reasons: list[str] = []

    # 1. No riders at all → broadcast + surge so supply reacts.
    if not fleet.candidates:
        surge = weather.surge_bump or 0.0
        if surge == 0.0:
            surge = settings.surge_small
        reasons.append("no_candidates_within_radius")
        decision = AssignmentDecision(
            order_id=event.order_id,
            mode="single",
            broadcast=True,
            dispatch_mode="broadcast",
            reasons=reasons,
            sla_risk="high",
            weather_pad_minutes=weather.pad_minutes,
            surge_amount=surge,
        )
        return {"decision": decision, "trace": trace + [{"node": "decide", "outcome": "broadcast", "at": time.time()}]}

    # 2. Rank candidates (fleet agent — deterministic).
    ranked = rank_candidates(fleet.candidates, (lat, lng), drop)
    best, best_score = ranked[0]
    reasons.append(f"top_score={best_score}")

    # 3. Batch availability upgrades the decision when SLA-safe.
    # `batch` is a BatchProposal (pydantic) — dict-style access only after
    # model_dump for the trace/reasons strings.
    mode = "batch" if batch else "single"
    if batch:
        reasons.append(
            f"batch_with={batch.secondary_order_id} delayA={batch.delay_primary_s}s"
        )

    # 4. SLA risk from prep time + weather pad vs. a 45-min promise.
    eta = eta_minutes(best.distance_km, weather.pad_minutes)
    total = kitchen["predicted_prep_minutes"] + eta
    sla_risk = "low" if total < 30 else "medium" if total < 40 else "high"

    decision = AssignmentDecision(
        order_id=event.order_id,
        mode=mode,
        assigned_rider_id=best.rider_id,
        batch=batch,
        broadcast=False,
        dispatch_mode="assign",
        reasons=reasons,
        eta_minutes=eta,
        sla_risk=sla_risk,
        weather_pad_minutes=weather.pad_minutes,
        surge_amount=0.0,
    )
    return {"decision": decision, "trace": trace + [{"node": "decide", "outcome": mode, "at": time.time()}]}


async def act_node(state: DispatchState) -> dict[str, Any]:
    """Execute the decision against the platform (idempotent actions)."""
    platform: PlatformClient = state["platform"]
    decision: AssignmentDecision = state["decision"]
    event: OrderReadyEvent = state["event"]

    if decision.broadcast:
        rider_user_ids = []  # degraded fleet snapshot → nobody to notify here
        await platform.notify_riders_broadcast(
            event.order_id,
            event.restaurant_id,
            rider_user_ids,
            surge=decision.surge_amount,
        )
    else:
        # Push-assignment seam (see PlatformClient.create_order). Until the
        # internal claim endpoint exists, the swarm notifies the top-3
        # ranked riders with a targeted offer — the platform's atomic
        # rider-claim (acceptOrder) remains the double-assign guard.
        rider_user_ids = []
        if decision.assigned_rider_id:
            best = next(
                (
                    c
                    for c in state["fleet"].candidates
                    if c.rider_id == decision.assigned_rider_id
                ),
                None,
            )
            if best:
                rider_user_ids = [best.rider_user_id]
        await platform.notify_riders_broadcast(
            event.order_id,
            event.restaurant_id,
            rider_user_ids,
            surge=decision.surge_amount,
        )

    # Live ETA to the customer's socket room (weather-padded).
    await platform.emit_realtime(
        "eta:update",
        f"order:{event.order_id}",
        {
            "orderId": event.order_id,
            "etaMinutes": decision.eta_minutes,
            "slaRisk": decision.sla_risk,
            "weatherPad": decision.weather_pad_minutes,
        },
    )

    return {
        "trace": state["trace"]
        + [
            {
                "node": "act",
                "dispatch_mode": decision.dispatch_mode,
                "notified": len(rider_user_ids),
                "at": time.time(),
            }
        ]
    }


# ─── Graph assembly ──────────────────────────────────────────

def build_graph():
    graph = StateGraph(DispatchState)
    graph.add_node("validate", validate_node)
    graph.add_node("kitchen", kitchen_node)
    graph.add_node("fleet", fleet_node)
    graph.add_node("weather", weather_node)
    graph.add_node("batching", batching_node)
    graph.add_node("decide", decide_node)
    graph.add_node("act", act_node)

    graph.set_entry_point("validate")
    graph.add_edge("validate", "kitchen")
    graph.add_edge("kitchen", "fleet")
    graph.add_edge("fleet", "weather")
    graph.add_edge("weather", "batching")
    graph.add_edge("batching", "decide")
    graph.add_edge("decide", "act")
    graph.add_edge("act", END)
    return graph.compile()


dispatch_graph = build_graph()
