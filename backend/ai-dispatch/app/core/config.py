"""Typed, fail-fast configuration for the dispatch swarm (serverless).

The shared shape (identity-plane secrets, resilience defaults, fail-fast
posture) lives in ``pycommon.config``; this file is only what is specific
to the dispatch swarm.
"""

from __future__ import annotations

from pycommon.config import BaseServiceSettings, cached_settings


class Settings(BaseServiceSettings):
    # ─── Service identity ────────────────────────────────────────
    app_name: str = "ai-dispatch"

    # ─── Sibling services (shared HTTP API in prod) ──────────────
    restaurant_service_url: str = "http://localhost:3003"
    rider_service_url: str = "http://localhost:3004"
    realtime_service_url: str = "http://localhost:3002"

    # ─── LLM (used ONLY inside bounded nodes) ────────────────────
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-haiku-4-5"
    llm_timeout_s: float = 20.0
    llm_max_tokens: int = 600

    # ─── Dispatch decision bounds ────────────────────────────────
    rider_search_radius_km: float = 10.0
    batch_radius_m: float = 500.0        # pickup co-location threshold
    batch_drop_radius_m: float = 2000.0  # drop co-location threshold
    batch_sla_penalty_s: int = 300       # max SLA delay batching may impose
    max_candidates: int = 12             # rider shortlist size
    prep_base_minutes: float = 18.0
    prep_per_item_minutes: float = 1.2
    prep_complexity_minutes: float = 6.0  # biryani-class dishes
    prep_queue_minutes: float = 2.0      # per order already in kitchen
    prep_min_minutes: float = 10.0
    prep_max_minutes: float = 45.0
    surge_small: float = 10.0            # ₹ incentive tiers
    surge_large: float = 25.0
    surge_cooloff_min: int = 10          # per-restaurant surge cooldown

    # ─── Resilience ──────────────────────────────────────────────
    internal_timeout_s: float = 4.0
    weather_timeout_s: float = 6.0        # external weather API budget
    max_graph_steps: int = 24

    # ─── Serverless state (DynamoDB; TTL sweeps) ─────────────────
    idempotency_ttl_s: int = 300         # ready-event claim lifetime
    pool_ttl_s: int = 7200               # broadcast pool row lifetime


get_settings = cached_settings(Settings)
