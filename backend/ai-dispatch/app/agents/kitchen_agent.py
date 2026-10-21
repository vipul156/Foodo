"""Kitchen Load Agent — predicts true prep completion time.

Pipeline: deterministic heuristic first (queue depth, dish complexity,
historical delay factor), then an OPTIONAL bounded LLM refinement that can
only nudge the estimate within ±40% of the heuristic — never below the
floor or above the ceiling. If the LLM is unavailable or returns garbage,
the heuristic stands. Prediction is logged with its inputs for replay.
"""

from __future__ import annotations

import time
from typing import Any

from app.core.config import get_settings
from app.core.logging import get_logger

log = get_logger(__name__)
settings = get_settings()

# Dish-complexity hints — keyword → extra minutes (deterministic table).
COMPLEXITY_KEYWORDS: dict[str, float] = {
    "biryani": 8.0,
    "dum": 6.0,
    "handi": 6.0,
    "tandoori": 5.0,
    "kebab": 5.0,
    "pizza": 7.0,
    "burger": 2.0,
    "momos": 3.0,
    "thali": 4.0,
    "beverage": -6.0,
    "cake": -4.0,
    "ice cream": -8.0,
}

_NUDGE_LIMIT = 0.4  # LLM may adjust ±40% of the heuristic


def _complexity_minutes(item_names: list[str]) -> float:
    total = 0.0
    lowered = [name.lower() for name in item_names]
    for keyword, minutes in COMPLEXITY_KEYWORDS.items():
        for name in lowered:
            if keyword in name:
                total += minutes
                break
    return max(0.0, total)


def predict_prep_minutes(
    *,
    item_names: list[str],
    queue_depth: int,
    historical_delay_factor: float = 1.0,
) -> tuple[float, dict[str, Any]]:
    """Deterministic heuristic — the LLM refines INSIDE these bounds.

    Returns (minutes, inputs_used).
    """
    base = settings.prep_base_minutes
    per_item = min(len(item_names), 8) * settings.prep_per_item_minutes
    complexity = _complexity_minutes(item_names)
    queue = queue_depth * settings.prep_queue_minutes
    raw = (base + per_item + complexity + queue) * max(0.8, min(1.5, historical_delay_factor))
    minutes = max(settings.prep_min_minutes, min(settings.prep_max_minutes, raw))
    return round(minutes, 1), [
        f"base={base}",
        f"items={len(item_names)}x{settings.prep_per_item_minutes}",
        f"complexity={complexity}",
        f"queue={queue_depth}x{settings.prep_queue_minutes}",
        f"delay_factor={historical_delay_factor}",
    ]


async def predict(
    order_id: str,
    item_names: list[str],
    kitchen_state: dict[str, Any],
    llm=None,
) -> dict[str, Any]:
    """Full agent: heuristic → optional bounded LLM nudge → KitchenPrediction dict."""
    from app.schemas.dispatch import KitchenPrediction

    queue_depth = int(kitchen_state.get("active_orders", 0))
    delay_factor = float(kitchen_state.get("delay_factor", 1.0))
    heuristic, inputs_used = predict_prep_minutes(
        item_names=item_names,
        queue_depth=queue_depth,
        historical_delay_factor=delay_factor,
    )

    refined = heuristic
    if llm is not None:
        started = time.perf_counter()
        try:
            prompt = (
                "Estimate restaurant prep time for this order. The deterministic "
                f"baseline is {heuristic} minutes (floor 10, ceiling 45). You may "
                f"adjust it by AT MOST ±40% ({heuristic * (1 - _NUDGE_LIMIT):.1f}–"
                f"{heuristic * (1 + _NUDGE_LIMIT):.1f}). Answer with JSON only: "
                '{"minutes": <number>, "reason": "<=12 words"}\n'
                f"Order items: {item_names[:10]}"
            )
            response = await llm.ainvoke(prompt)
            text = response.content if hasattr(response, "content") else str(response)
            refined = _parse_nudge(text, heuristic)
        except Exception as exc:  # noqa: BLE001 — LLM trouble never blocks dispatch
            log.warning("kitchen LLM refinement failed: %s", exc)
            refined = heuristic
        log.info(
            "kitchen prediction order=%s heuristic=%s refined=%s in %dms",
            order_id,
            heuristic,
            refined,
            int((time.perf_counter() - started) * 1000),
        )

    prediction = KitchenPrediction(
        order_id=order_id,
        predicted_prep_minutes=refined,
        queue_depth=queue_depth,
        complexity_factor=round(complexity_of(item_names), 2),
        inputs_used=inputs_used,
        degraded=not bool(kitchen_state),
    )
    return prediction.model_dump()


def complexity_of(item_names: list[str]) -> float:
    """Normalized 0..1 complexity score (for the decision trace)."""
    raw = _complexity_minutes(item_names)
    return max(0.0, min(1.0, raw / 20.0))


def _parse_nudge(text: str, heuristic: float) -> float:
    """Defensive parse: JSON-or-nothing, clamped to ±40% of heuristic."""
    import json
    import re

    match = re.search(r"\{[^{}]*\}", text or "")
    if not match:
        return heuristic
    try:
        data = json.loads(match.group(0))
        minutes = float(data.get("minutes", heuristic))
    except Exception:  # noqa: BLE001
        return heuristic
    lower = heuristic * (1 - _NUDGE_LIMIT)
    upper = heuristic * (1 + _NUDGE_LIMIT)
    return round(max(lower, min(upper, minutes)), 1)
