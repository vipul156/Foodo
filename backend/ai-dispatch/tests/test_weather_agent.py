"""Weather reflex tests — deterministic WMO mapping + cache."""

from __future__ import annotations

from app.agents import weather_agent
from app.agents.weather_agent import _WMO_MAP, get_weather_reflex
from app.schemas.dispatch import WeatherReflex


def test_storm_codes_map_to_big_pads():
    pad, surge, condition = _WMO_MAP[99]
    assert pad >= 25 and surge >= 40 and condition == "storm"


def test_clear_code_maps_to_zero():
    assert _WMO_MAP[0] == (0, 0, "clear")


def test_cache_hit_within_ttl(monkeypatch):
    # Seed the cache; a cached hit must not hit the network.
    key = weather_agent._cache_key(12.97, 77.59)
    cached = WeatherReflex(pad_minutes=7, surge_bump=9, condition="rain")
    weather_agent._cache[key] = (weather_agent.time.time(), cached)
    import asyncio

    result = asyncio.run(get_weather_reflex(12.97, 77.59))
    assert result.pad_minutes == 7
    weather_agent._cache.pop(key, None)
