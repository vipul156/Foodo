"""OpenAI-compatible vision client — structured JSON extraction from menu photos.

One model, any vendor: ``LLM_PROVIDER`` / ``LLM_MODEL`` / ``LLM_API_KEY``
(plus ``LLM_BASE_URL`` for a self-hosted gateway) pick the endpoint, which
must accept ``image_url`` content parts and ``response_format=json_object``.
The prompt pins the JSON contract, so output is a typed menu tree, not free
text. Parsing is defensive: fences, prose, and malformed shapes degrade to
a clear error — never a partial DB write (that's the review grid's job
anyway).
"""

from __future__ import annotations

import base64
import re

from pycommon.llm import LlmSettings
from pycommon.logging import get_logger

from app.core.config import get_settings
from app.core.resilience import BreakerOpen, call_with_resilience, pools

log = get_logger(__name__)
settings = get_settings()


class VisionError(Exception):
    """The vision engine failed or returned unusable output."""


SYSTEM_PROMPT = """You are a menu-digitization engine for a food delivery platform. \
Extract EVERY dish from this printed/handwritten menu photo into the JSON \
object described below. You must:

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
Do not add dishes that are not printed.

Return ONLY this JSON object (no prose, no markdown fences):
{
  "categories": [
    {
      "name": "<printed section header>",
      "items": [
        {
          "name": "<dish name>",
          "description": "<printed description or empty string>",
          "price": <number>,
          "currency": "<INR|USD|...>",
          "is_veg": <true|false|null>,
          "spicy_level": "<none|mild|medium|hot|unknown>",
          "allergens": ["<dairy|gluten|nuts|eggs|soy|shellfish|fish>"]
        }
      ]
    }
  ],
  "menu_language": "<primary language of the menu>",
  "parse_warnings": ["<anything you could not read cleanly>"]
}"""


def _headers(cfg: LlmSettings) -> dict[str, str]:
    """JSON content type plus a bearer token when the provider needs one."""
    headers = {"content-type": "application/json"}
    if cfg.api_key:  # keyless local runtimes (ollama/lmstudio) leave this empty
        headers["authorization"] = f"Bearer {cfg.api_key}"
    return headers


def _build_payload(cfg: LlmSettings, encoded: str, mime_type: str) -> dict:
    """Chat Completions payload asking for a JSON object back."""
    return {
        "model": cfg.model,
        "temperature": 0,
        "max_tokens": cfg.max_tokens,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:{mime_type};base64,{encoded}",
                        },
                    },
                    {
                        "type": "text",
                        "text": "Digitize this menu photo and return the JSON object.",
                    },
                ],
            },
        ],
    }


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
    cfg = settings.llm
    if not cfg.is_configured:  # settings already fail closed; belt and braces
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
    payload = _build_payload(cfg, encoded, mime_type)
    headers = _headers(cfg)

    async def _call() -> dict:
        response = await pools.vision.post(
            f"{cfg.endpoint}/chat/completions",
            headers=headers,
            json=payload,
        )
        response.raise_for_status()
        return response.json()

    try:
        raw = await call_with_resilience("vision-chat", _call, retries=1)
    except BreakerOpen as exc:
        raise VisionError("vision engine overloaded — try again shortly") from exc
    except Exception as exc:  # noqa: BLE001
        raise VisionError(f"vision engine call failed: {exc}") from exc

    text = _extract_text(raw)
    parsed = _parse_json(text)
    if parsed is None:
        raise VisionError("vision engine returned unusable output")
    meta = {
        "provider": f"{cfg.provider}:{cfg.model}",
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
    """Read `choices[0].message.content` (string or text parts)."""
    choices = raw.get("choices") or []
    for choice in choices:
        content = (choice.get("message") or {}).get("content")
        if isinstance(content, str) and content.strip():
            return content
        if isinstance(content, list):
            text = "".join(
                part.get("text", "") for part in content if isinstance(part, dict)
            )
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
