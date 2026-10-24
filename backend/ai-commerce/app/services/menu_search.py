"""Configuration seam for semantic menu search.

Design target (the seam this module exposes) is a Qdrant collection
`menu_items` with one point per MenuItem, payload:

    { "itemId": "...", "restaurantId": "...", "name": "...", "category": "..." }

Until a Qdrant instance + embedding job is provisioned, this module falls
back to a deterministic lexical scorer (token F1 + substring + category
boosts, sigmoid-squashed). The agent code depends ONLY on the public
functions below — swapping in Qdrant (langchain-qdrant + embeddings) or
pgvector touches this file alone.
"""

from __future__ import annotations

import math
import re
import unicodedata
from dataclasses import dataclass

from pycommon.logging import get_logger

from app.core.config import get_settings

log = get_logger(__name__)
settings = get_settings()

_TOKEN_RE = re.compile(r"[a-z0-9]+")
_STOP = {"the", "a", "an", "with", "and", "of", "some", "my", "me", "i", "for", "in", "on"}


@dataclass(slots=True)
class MenuCandidate:
    item_id: str
    restaurant_id: str
    name: str
    item: dict  # raw menu payload for cross-checking (id/price integrity)
    score: float


def _tokens(text: str) -> list[str]:
    norm = unicodedata.normalize("NFKD", str(text).lower())
    return [t for t in _TOKEN_RE.findall(norm) if t not in _STOP]


def lexical_score(query: str, name: str, category: str = "") -> float:
    """0..1 similarity: token F1 + substring bonus + category bonus."""
    q = set(_tokens(query))
    n = set(_tokens(name))
    if not q or not n:
        return 0.0
    overlap = len(q & n)
    precision = overlap / len(q)
    recall = overlap / len(n)
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0

    name_lower = name.lower()
    if query.lower() in name_lower or name_lower in query.lower():
        f1 = min(1.0, f1 + 0.25)

    if q & set(_tokens(category)):
        f1 = min(1.0, f1 + 0.1)

    # Sigmoid squash — borderline matches fall under the match threshold.
    return 1 / (1 + math.exp(-(f1 * 4 - 2)))


def rank_menu_sync(
    candidates: list[dict],
    query: str,
    *,
    limit: int | None = None,
) -> list[MenuCandidate]:
    """Rank menu dicts against a fuzzy user phrase (deterministic).

    `candidates` are menu item dicts from the restaurant service:
    { id, restaurantId, name, category, price, isAvailable, ... }
    (`_id` is the pre-Dynamo field name — still accepted). Unavailable
    items are excluded; results are capped and thresholded.
    """
    max_results = limit or settings.max_menu_candidates
    scored: list[MenuCandidate] = []
    for item in candidates:
        # The catalog moved from Mongo `_id` to DynamoDB `id`; a menu
        # item without an id can never be added to a draft, so it is
        # skipped rather than crashing the tool.
        item_id = item.get("id") or item.get("_id")
        if not item_id or not item.get("isAvailable", True):
            continue
        score = lexical_score(query, str(item.get("name", "")), str(item.get("category", "")))
        if score >= settings.semantic_match_threshold:
            scored.append(
                MenuCandidate(
                    item_id=str(item_id),
                    restaurant_id=str(item.get("restaurantId", "")),
                    name=str(item.get("name", "")),
                    item=item,
                    score=round(score, 4),
                )
            )
    scored.sort(key=lambda c: c.score, reverse=True)
    return scored[:max_results]


async def rank_menu(candidates: list[dict], query: str, *, limit: int | None = None) -> list[MenuCandidate]:
    """Async seam — the future Qdrant/pgvector call site (same contract)."""
    return rank_menu_sync(candidates, query, limit=limit)


def search_menu(candidates: list[dict], query: str, *, limit: int | None = None) -> list[MenuCandidate]:
    """Sync convenience alias (tests + callers without an event loop)."""
    return rank_menu_sync(candidates, query, limit=limit)
