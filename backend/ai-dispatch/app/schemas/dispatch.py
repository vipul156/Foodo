"""Dispatch domain contracts — typed boundaries for every stage.

The LLM never invents domain state: every struct below is validated at
the boundary, and the final assignment decision is made by deterministic
policy code, not by a model.
"""

from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class GeoPoint(BaseModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)


class OrderReadyEvent(BaseModel):
    """The `order:ready_for_rider` payload from the restaurant service."""

    order_id: str = Field(alias="orderId")
    restaurant_id: str = Field(alias="restaurantId")
    location: dict[str, Any]  # GeoJSON Point { type, coordinates: [lng, lat] }

    model_config = {"populate_by_name": True}

    @property
    def coords(self) -> tuple[float, float]:
        lng, lat = self.location["coordinates"][:2]
        return float(lat), float(lng)


class BatchMember(BaseModel):
    order_id: str
    restaurant_id: str
    pickup: GeoPoint
    dropoff: GeoPoint


class BatchProposal(BaseModel):
    """Two orders the batching agent proposes to bundle (VRP-lite)."""

    primary_order_id: str
    secondary_order_id: str
    primary_pickup: GeoPoint
    secondary_pickup: GeoPoint
    primary_dropoff: GeoPoint
    secondary_dropoff: GeoPoint
    delay_primary_s: int = Field(ge=0)      # SLA delay imposed on A
    delay_secondary_s: int = Field(ge=0)
    combined_distance_km: float = Field(ge=0)


class KitchenPrediction(BaseModel):
    """Output of the kitchen prep prediction agent."""

    order_id: str
    predicted_prep_minutes: float
    queue_depth: int
    complexity_factor: float
    inputs_used: list[str] = []
    degraded: bool = False  # True when history was unavailable → base heuristic


class RiderCandidate(BaseModel):
    rider_id: str
    rider_user_id: str
    name: str
    phone: str | None = None
    picture: str | None = None
    location: GeoPoint
    distance_km: float
    heading_match: float = Field(ge=0, le=1, default=0.5)


class FleetSnapshot(BaseModel):
    candidates: list[RiderCandidate]
    source: str = "rider-service"   # or "live-state" (Redis) when available
    degraded: bool = False


class AssignmentDecision(BaseModel):
    """The swarm's verdict — deterministic policy output."""

    order_id: str
    mode: str  # "single" | "batch"
    assigned_rider_id: str | None = None
    batch: BatchProposal | None = None
    broadcast: bool = False            # true when nobody was assignable
    reasons: list[str] = []
    dispatch_mode: str = "assign"      # "assign" | "broadcast"
    eta_minutes: float | None = None
    sla_risk: str = "low"              # low | medium | high
    weather_pad_minutes: float = 0.0
    surge_amount: float = 0.0


class DecisionEnvelope(BaseModel):
    """Wire shape on dispatch.events fanout."""

    type: str
    decision: AssignmentDecision
    trace: list[dict[str, Any]] = []
    at: float


class WeatherReflex(BaseModel):
    """Output of the weather & congestion reflex."""

    pad_minutes: float = Field(default=0.0, ge=0, le=60)
    surge_bump: float = Field(default=0.0, ge=0)
    condition: str = "clear"           # clear | rain | storm | snow
    source: str = "open-meteo"
    degraded: bool = False


class DispatchHealth(BaseModel):
    status: str = "UP"
    orders_dispatched: int = 0
    batches_formed: int = 0
    broadcasts: int = 0
    weather_degraded: bool = False
