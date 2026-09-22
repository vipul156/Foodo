"""Gemini Flash vision client — structured JSON extraction from menu photos.

The model is configured with a response schema (JSON mode) so output is a
typed menu tree, not free text. Parsing is defensive: fences, prose, and
malformed shapes degrade to a clear error — never a partial DB write
(that's the review grid's job anyway).
"""

from __future__ import annotations

import base64
import re

from app.core.config import get_settings
from app.core.logging import get_logger
from app.core.resilience import BreakerOpen, call_with_resilience, pools

log = get_logger(__name__)
settings = get_settings()


class VisionError(Exception):
    """The vision engine failed or returned unusable output."""


# The JSON contract Gemini must fill — mirrors ParsedMenu exactly.
# responseSchema forces structure; the system prompt adds the semantic
# rules (multi-column layouts, dotted-leader prices, veg markers).
_RESPONSE_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "categories": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "items": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string"},
                                "description": {"type": "string"},
                                "price": {"type": "number"},
                                "currency": {"type": "string"},
                                "is_veg": {
                                    "type": "object",
                                    "nullable": True,
                                    "enum": [True, False, None],
                                },
                                "spicy_level": {
                                    "type": "string",
                                    "enum": ["none", "mild", "medium", "hot", "unknown"],
                                },
                                "allergens": {
                                    "type": "array",
                                    "items": {
                                        "type": "string",
                                        "enum": [
                                            "dairy", "gluten", "nuts", "eggs",
                                            "soy", "shellfish", "fish",
                                        ],
                                    },
                                },
                            },
                            "required": ["name", "price"],
                        },
                    },
                },
                "required": ["name", "items"],
            },
        },
        "menu_language": {"type": "string"},
        "parse_warnings": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["categories"],
}

SYSTEM_PROMPT = """You are a menu-digitization engine for a food delivery platform. \
Extract EVERY dish from this printed/handwritten menu photo into the required JSON \
structure. You must:

1. LAYOUT: Detect multi-column layouts and group each item under its printed \
section header (Starters, Main Course, Breads, Beverages...). Use the printed \
header text as category name; if the menu has no headers, use category_hint \
grouping like "Others".
2. PRICES: Associate the dish name on the left with the price on the right, even \
across dotted leaders (".....") or alignment gaps. Parse currency symbols \
(₹, Rs, Rs., $, £) into the currency field (3-letter ISO code, default INR) and \
the price as a clean number ONLY — no symbols, no commas, no "/-", no text.
3. ATTRIBUTES: Mark is_veg true only for a green dot/veg marker or the words \
"veg"/"vegetarian"; false for red marker or chicken/mutton/fish/egg keywords; \
null when uncertain. Map chili symbols 🌶/chili icons to spicy_level. Tag \
allergens ONLY from explicit text (paneer→dairy, maida/flour→gluten, \
cashew/almond→nuts, egg→eggs).
4. DESCRIPTIONS: Include the printed description under a dish if present; \
never invent descriptions.
5. HONESTY: If a price is illegible, use your best reading and add a note to \
parse_warnings like "price unclear for X". Never skip dishes you can see. \
Do not add dishes that are not printed."""


def extract_public_id_from_cloudinary_url(url: str) -> str | None:
    """Best-effort public-id extraction (for logging/trace only).

    Delivery URLs look like ``.../image/upload/<transformations>/v<ms>/<folders>/<id>.<ext>``
    — everything after the last ``v<milliseconds>`` version marker is the
    public id. Without a version marker we fall back to stripping leading
    transformation segments (best-effort only).
    """
    marker = "/image/upload/"
    idx = url.find(marker)
    if idx == -1:
        return None
    segments = [s for s in url[idx + len(marker):].split("/") if s]
    version_idx = None
    for i, seg in enumerate(segments):
        if re.fullmatch(r"v\d+", seg):
            version_idx = i
    if version_idx is not None:
        segments = segments[version_idx + 1 :]
    else:
        while len(segments) > 1 and re.match(r"^(e_|c_|w_|h_|q_|f_|g_|b_|r_)", segments[0]):
            segments.pop(0)
    tail = "/".join(segments)
    return re.sub(r"\.[a-z0-9]+$", "", tail) or None


async def parse_menu_image(
    image_url: str,
    *,
    mime_type: str = "image/jpeg",
) -> tuple[dict, dict]:
    """Fetch the image and run structured vision extraction.

    Returns (parsed_dict, meta) where parsed_dict validates against
    ParsedMenu and meta carries provider/timing/usage info.
    Raises VisionError on any failure — callers degrade to a 502.
    """
    import time

    started = time.perf_counter()
    if settings.gemini_api_key == "":
        raise VisionError("vision provider not configured")

    # ─── Image fetch (from Cloudinary URL) with hygiene checks ──
    try:
        response = await pools.internal.get(image_url)  # pool shares timeout caps
        response.raise_for_status()
        image_bytes = response.content
    except Exception as exc:  # noqa: BLE001
        raise VisionError(f"could not fetch menu image: {exc}") from exc

    if len(image_bytes) > settings.max_image_bytes:
        raise VisionError(
            f"menu image too large ({len(image_bytes)} bytes, max {settings.max_image_bytes})"
        )
    sniffed = _sniff_image_type(image_bytes)
    if sniffed is None:
        raise VisionError("not a valid image (magic-byte check failed)")
    mime_type = sniffed

    encoded = base64.b64encode(image_bytes).decode()

    # ─── Structured vision call ─────────────────────────────────
    payload = {
        "contents": [
            {
                "parts": [
                    {
                        "inline_data": {
                            "mime_type": mime_type,
                            "data": encoded,
                        }
                    },
                    {"text": SYSTEM_PROMPT},
                ]
            }
        ],
        "generationConfig": {
            "responseMime": "application/json",
            "responseSchema": _RESPONSE_SCHEMA,
            "temperature": 0,
            "maxOutputTokens": settings.gemini_max_output_tokens,
        },
    }

    async def _call() -> dict:
        response = await pools.gemini.post(
            (
                "https://generativelanguage.googleapis.com/v1beta/models/"
                f"{settings.gemini_model}:generateContent"
            ),
            params={"key": settings.gemini_api_key},
            json=payload,
        )
        response.raise_for_status()
        return response.json()

    try:
        raw = await call_with_resilience("gemini-vision", _call, retries=1)
    except BreakerOpen as exc:
        raise VisionError("vision engine overloaded — try again shortly") from exc
    except Exception as exc:  # noqa: BLE001
        raise VisionError(f"vision engine call failed: {exc}") from exc

    text = _extract_text(raw)
    parsed = _parse_json(text)
    if parsed is None:
        raise VisionError("vision engine returned unusable output")
    meta = {
        "provider": f"gemini:{settings.gemini_model}",
        "duration_ms": int((time.perf_counter() - started) * 1000),
        "image_bytes": len(image_bytes),
    }
    return parsed, meta


def _sniff_image_type(data: bytes) -> str | None:
    """Magic-byte MIME check — never trust the URL extension."""
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def _extract_text(raw: dict) -> str:
    candidates = raw.get("candidates") or []
    for candidate in candidates:
        content = candidate.get("content") or {}
        parts = content.get("parts") or []
        texts = [p.get("text", "") for p in parts if isinstance(p, dict)]
        text = "".join(texts)
        if text.strip():
            return text
    return ""


def _parse_json(text: str) -> dict | None:
    """Defensive JSON extraction — fences/prose tolerated, garbage → None."""
    if not text:
        return None
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    candidate = (fenced.group(1) if fenced else text).strip()
    start, end = candidate.find("{"), candidate.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        parsed = json_loads(candidate[start : end + 1])
    except Exception:  # noqa: BLE001
        return None
    return parsed if isinstance(parsed, dict) else None


def json_loads(text: str):
    import json

    return json.loads(text)
