"""Parser orchestration — vision output → normalized review draft.

Pipeline:
  Gemini (JSON mode) → ParsedMenu validation → deterministic
  normalization (category casing, veg inference from names, price
  sanity) → ParseDraft for the interactive review grid.

No DB writes here: the owner confirms via the review grid, then the
restaurant service's bulk endpoint persists (human-in-the-loop by law).
"""

from __future__ import annotations

import re
import time
import uuid

from pycommon.logging import get_logger

from app.clients.gemini import VisionError, parse_menu_image
from app.core.config import get_settings
from app.schemas.menu import (
    NormalizedItem,
    ParsedCategory,
    ParsedItem,
    ParseDraft,
    ParsedMenu,
    SpiceLevel,
)

log = get_logger(__name__)
settings = get_settings()

_VEG_WORDS = re.compile(
    r"\b(paneer|veg|vegetarian|aloo|gobi|palak|dal|daal|chana|rajma|"
    r"malai kofta|dahi|khichdi|upma|poha|idli|dosa|vada|samosa)\b",
    re.I,
)
_NONVEG_WORDS = re.compile(
    r"\b(chicken|mutton|goat|lamb|beef|pork|fish|prawn|shrimp|crab|egg|"
    r"kebab|tikka|tandoori chicken|biryani chicken|murgh)\b",
    re.I,
)

_TITLE_CASE_MINOR = {"and", "of", "the", "with", "in"}


def _titlecase_category(name: str) -> str:
    words = name.strip().split()
    if not words:
        return "Others"
    titled = [
        w.lower() if w.lower() in _TITLE_CASE_MINOR else w.capitalize()
        for w in words
    ]
    return " ".join(titled)


def infer_veg(item: ParsedItem) -> bool | None:
    """Deterministic veg inference — marker wins, then name keywords."""
    if item.is_veg is not None:
        return item.is_veg
    name = item.name
    if _NONVEG_WORDS.search(name):
        return False
    if _VEG_WORDS.search(name):
        return True
    return None


def normalize_item(item: ParsedItem, category: str) -> NormalizedItem:
    return NormalizedItem(
        category=_titlecase_category(category),
        name=item.name,
        description=item.description.strip(),
        price=round(float(item.price), 2),
        is_veg=infer_veg(item),
        spicy_level=item.spicy_level if item.spicy_level else SpiceLevel.UNKNOWN,
        allergens=list(item.allergens),
    )


def normalize_menu(menu: ParsedMenu) -> list[NormalizedItem]:
    items: list[NormalizedItem] = []
    for category in menu.categories:
        for item in category.items:
            items.append(normalize_item(item, category.name))
    return items


async def create_parse_draft(image_url: str) -> ParseDraft:
    """Full parse → validate → normalize → draft. Raises VisionError."""
    parsed_raw, meta = await parse_menu_image(image_url)

    try:
        menu = ParsedMenu.model_validate(parsed_raw)
    except Exception as exc:  # noqa: BLE001
        raise VisionError(f"vision output failed validation: {exc}") from exc

    normalized = normalize_menu(menu)
    draft_id = f"mp{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}"

    # The draft carries the PARSED tree (for the grid) plus the
    # normalized view is derivable client-side; warnings surface
    # illegible prices so the owner double-checks them.
    return ParseDraft(
        draft_id=draft_id,
        image_url=image_url,
        categories=menu.categories,
        warnings=menu.parse_warnings,
        provider=meta["provider"],
        duration_ms=meta["duration_ms"],
    )
