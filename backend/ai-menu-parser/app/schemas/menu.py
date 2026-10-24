"""Menu parse contracts — the typed boundary around the vision model.

The Gemini response MUST validate against ParsedMenu before any
downstream code sees it. Normalization (price cleanup, dietary flags,
category naming) is deterministic Python; the model proposes, Pydantic
disposes.
"""

from __future__ import annotations

import re
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field, field_validator, model_validator

# ─── Canonical allergen buckets + ingredient aliases ───────────
# The prompt asks the vision model for canonical buckets, but OCR fuzz
# often emits raw ingredients — bucket them defensively here.
_ALLERGEN_ALIASES: dict[str, str] = {
    "dairy": "dairy", "milk": "dairy", "paneer": "dairy", "cheese": "dairy",
    "ghee": "dairy", "butter": "dairy", "yogurt": "dairy", "curd": "dairy",
    "cream": "dairy", "khoya": "dairy", "paneercheese": "dairy",
    "gluten": "gluten", "maida": "gluten", "flour": "gluten", "wheat": "gluten",
    "atta": "gluten", "bread": "gluten", "sooji": "gluten", "rava": "gluten",
    "nuts": "nuts", "nut": "nuts", "cashew": "nuts", "almond": "nuts",
    "pistachio": "nuts", "walnut": "nuts", "peanut": "nuts", "groundnut": "nuts",
    "egg": "eggs", "eggs": "eggs", "mayonnaise": "eggs", "mayo": "eggs",
    "soy": "soy", "soya": "soy", "tofu": "soy", "edamame": "soy",
    "shellfish": "shellfish", "prawn": "shellfish", "shrimp": "shellfish",
    "lobster": "shellfish", "crab": "shellfish",
    "fish": "fish", "anchovy": "fish", "tuna": "fish", "salmon": "fish",
}

# ─── Vision output schema (the JSON contract Gemini fills) ───


class SpiceLevel(str, Enum):
    NONE = "none"
    MILD = "mild"
    MEDIUM = "medium"
    HOT = "hot"
    UNKNOWN = "unknown"


class ParsedItem(BaseModel):
    """One dish as extracted from the menu image."""

    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=500)
    price: float = Field(ge=0)
    currency: str = Field(default="INR", pattern=r"^[A-Z]{3}$")
    is_veg: bool | None = Field(
        default=None,
        description="Green marker/keyword → true; red/non-veg keyword → false; unknown → null",
    )
    spicy_level: SpiceLevel = SpiceLevel.UNKNOWN
    allergens: list[str] = Field(default_factory=list)
    category_hint: str = Field(default="", max_length=80)

    @field_validator("name")
    @classmethod
    def _clean_name(cls, v: str) -> str:
        cleaned = re.sub(r"\s+", " ", v).strip(" .•·-–—")
        if not cleaned:
            raise ValueError("empty name")
        return cleaned[:120]

    @field_validator("allergens")
    @classmethod
    def _norm_allergens(cls, v: list[str]) -> list[str]:
        """Map ingredient mentions to canonical allergen buckets.

        The vision prompt asks the model to emit canonical buckets already,
        but blurry OCR output may carry raw ingredients ("cashew", "maida")
        — defensively bucket them here. Unknown tokens are dropped.
        """
        buckets: set[str] = set()
        for raw in v:
            canonical = _ALLERGEN_ALIASES.get(raw.strip().lower())
            if canonical:
                buckets.add(canonical)
        return sorted(buckets)


class ParsedCategory(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    items: list[ParsedItem] = Field(min_length=1)

    @field_validator("name")
    @classmethod
    def _clean_name(cls, v: str) -> str:
        cleaned = re.sub(r"\s+", " ", v).strip(" .•·-–—")
        return cleaned[:80] if cleaned else "Others"


class ParsedMenu(BaseModel):
    """The full vision-engine output, strictly validated."""

    categories: list[ParsedCategory]
    menu_language: str = Field(default="en", max_length=8)
    parse_warnings: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _bounds(self) -> "ParsedMenu":
        settings = get_settings_local()
        if len(self.categories) > settings.max_categories:
            self.categories = self.categories[: settings.max_categories]
        total = 0
        for cat in self.categories:
            if len(cat.items) > settings.max_items_per_category:
                cat.items = cat.items[: settings.max_items_per_category]
            total += len(cat.items)
        if total == 0:
            raise ValueError("vision engine returned no items — refusing empty parse")
        if total > settings.max_menu_items:
            # Trim tail categories first (usually beverages/add-ons).
            excess = total - settings.max_menu_items
            for cat in reversed(self.categories):
                if excess <= 0:
                    break
                take = min(excess, len(cat.items))
                cat.items = cat.items[:-take] if take < len(cat.items) else []
                excess -= take
            self.categories = [c for c in self.categories if c.items]
        return self


def get_settings_local():
    from app.core.config import get_settings

    return get_settings()


# ─── Normalized item (what lands in Mongo via the bulk endpoint) ──


class NormalizedItem(BaseModel):
    category: str
    name: str
    description: str = ""
    price: float = Field(ge=0)
    is_veg: bool | None = None
    spicy_level: SpiceLevel = SpiceLevel.UNKNOWN
    allergens: list[str] = []


class BulkPublishRequest(BaseModel):
    """One-click bulk seeding — the owner-verified review grid payload."""

    # Optional. The restaurant service resolves ownership from the signed
    # session and is the only authority on which menu may be written; this
    # field exists so the client can assert which restaurant it believes it
    # is publishing to. Platform ids are UUIDs (Dynamo), not 24-hex ObjectIds.
    restaurant_id: str | None = Field(default=None, max_length=64)
    items: list[NormalizedItem] = Field(min_length=1, max_length=300)
    replace_existing: bool = False


class BulkPublishResult(BaseModel):
    created: int
    skipped: list[str] = []
    restaurant_id: str | None = None


# ─── Review-grid draft (returned to the UI) ──────────────────


class ParseDraft(BaseModel):
    """The interactive review payload — owner tweaks before publishing."""

    draft_id: str
    image_url: str
    categories: list[ParsedCategory]
    warnings: list[str] = []
    provider: str
    duration_ms: int
