"""Weather & Congestion Reflex — pads ETAs and bumps incentives.

Ingests Open-Meteo current weather (no API key required) with a short
per-region cache. Deterministic mapping: condition → ETA pad minutes +
surge bump. Degrades to clear when the API is unreachable — dispatch
never blocks on weather.
"""

from __future__ import annotations

import time

import httpx

from pycommon.logging import get_logger

from app.core.config import get_settings
from app.core.resilience import call_with_resilience, pools
from app.schemas.dispatch import WeatherReflex

log = get_logger(__name__)
settings = get_settings()

_CACHE_TTL_S = 600
_cache: dict[str, tuple[float, WeatherReflex]] = {}

# WMO weather codes (Open-Meteo) → (pad_minutes, surge_bump, condition)
_WMO_MAP: dict[int, tuple[float, float, str]] = {
    0: (0, 0, "clear"),
    1: (0, 0, "clear"),
    2: (2, 0, "clear"),
    3: (4, 5, "cloudy"),
    45: (4, 5, "fog"),
    48: (6, 10, "fog"),
    51: (5, 8, "rain"),
    53: (7, 12, "rain"),
    55: (10, 18, "rain"),
    61: (8, 12, "rain"),
    63: (12, 20, "rain"),
    65: (18, 30, "rain"),
    71: (10, 15, "snow"),
    73: (15, 25, "snow"),
    75: (22, 35, "snow"),
    80: (9, 15, "rain"),
    81: (13, 22, "rain"),
    82: (20, 32, "rain"),
    95: (20, 30, "storm"),
    96: (25, 40, "storm"),
    99: (30, 45, "storm"),
}


def _cache_key(latitude: float, longitude: float) -> str:
    return f"{round(latitude, 2)}:{round(longitude, 2)}"


async def get_weather_reflex(latitude: float, longitude: float) -> WeatherReflex:
    """Cached, breaker-protected weather reflex. Degrades to clear."""
    key = _cache_key(latitude, longitude)
    now = time.time()
    hit = _cache.get(key)
    if hit and now - hit[0] < _CACHE_TTL_S:
        return hit[1]

    reflex = WeatherReflex()  # degraded default: clear, no pad
    try:

        async def _fetch() -> dict:
            response = await pools.weather.get(
                "https://api.open-meteo.com/v1/forecast",
                params={
                    "latitude": latitude,
                    "longitude": longitude,
                    "current": "weather_code,wind_speed_10m,precipitation",
                },
            )
            response.raise_for_status()
            return response.json()

        data = await call_with_resilience("open-meteo", _fetch, retries=1)
        current = (data or {}).get("current") or {}
        code = int(current.get("weather_code", 0))
        pad, surge, condition = _WMO_MAP.get(code, (4, 5, "rain"))
        # Wind aggravation: strong winds add padding regardless of code.
        wind = float(current.get("wind_speed_10m", 0) or 0)
        if wind > 30:
            pad += 5
            surge += 5
        reflex = WeatherReflex(
            pad_minutes=min(60.0, float(pad)),
            surge_bump=float(surge),
            condition=condition,
            source="open-meteo",
            degraded=False,
        )
    except Exception as exc:  # noqa: BLE001 — weather is advisory
        log.warning("weather reflex degraded: %s", exc)
        reflex = WeatherReflex(degraded=True)

    _cache[key] = (now, reflex)
    return reflex
