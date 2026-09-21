"""Kitchen Load Agent tests — deterministic heuristic + bounded LLM nudge."""

from __future__ import annotations

from app.agents.kitchen_agent import _parse_nudge, complexity_of, predict_prep_minutes


def test_baseline_within_bounds():
    minutes, _ = predict_prep_minutes(item_names=["Burger"], queue_depth=0)
    assert settings_bounds(minutes)


def settings_bounds(minutes: float) -> bool:
    from app.core.config import get_settings

    s = get_settings()
    return s.prep_min_minutes <= minutes <= s.prep_max_minutes


def test_queue_depth_increases_time():
    light, _ = predict_prep_minutes(item_names=["Burger"], queue_depth=0)
    heavy, _ = predict_prep_minutes(item_names=["Burger"], queue_depth=5)
    assert heavy > light


def test_biryani_beats_burger():
    biryani, _ = predict_prep_minutes(item_names=["Hyderabadi Biryani"], queue_depth=0)
    burger, _ = predict_prep_minutes(item_names=["Chicken Burger"], queue_depth=0)
    assert biryani > burger


def test_delay_factor_multiplier():
    base, _ = predict_prep_minutes(item_names=["Burger"], queue_depth=0)
    slow, _ = predict_prep_minutes(
        item_names=["Burger"], queue_depth=0, historical_delay_factor=1.5
    )
    assert slow > base


def test_llm_nudge_is_clamped():
    # Wild LLM answers are clamped to ±40% of the heuristic.
    assert _parse_nudge('{"minutes": 500}', 20.0) == 28.0
    assert _parse_nudge('{"minutes": 1}', 20.0) == 12.0
    assert _parse_nudge("no json here", 20.0) == 20.0
    assert _parse_nudge('{"minutes": "garbage"}', 20.0) == 20.0


def test_complexity_score_normalized():
    assert complexity_of(["Ice Cream"]) == 0.0
    assert complexity_of(["Chicken Biryani"]) > 0.0
