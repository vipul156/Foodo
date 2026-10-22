"""HTTP surface for the AI menu parser.

  POST /api/menu-parser/parse    — menu photo URL → review-grid draft
  POST /api/menu-parser/bulk     — owner-verified items → restaurant svc bulk persist
  GET  /health                   — liveness

`parse` authenticates the SELLER via the shared session cookie (the same
identity plane as everywhere else) and never writes to Mongo. `bulk`
proxies the owner-verified array to the restaurant service, which owns
the menuitems collection — data ownership stays with the domain service.
"""

from __future__ import annotations

import base64

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.api.deps import get_cookie_header, require_user
from app.clients.gemini import VisionError
from app.core.config import get_settings
from app.core.ratelimit import enforce_rate_limit
from app.core.security import Identity, service_headers
from app.schemas.menu import BulkPublishRequest, BulkPublishResult, ParseDraft
from app.services.parser_service import create_parse_draft

settings = get_settings()
router = APIRouter(prefix="/api/menu-parser", tags=["menu-parser"])


@router.post("/parse", response_model=ParseDraft)
async def parse_menu(
    request: Request,
    identity: Identity = Depends(require_user),
    cookie_header: str = Depends(get_cookie_header),
) -> ParseDraft:
    """Menu photo (Cloudinary URL from the direct-upload flow) → draft."""
    await enforce_rate_limit(f"menu-parser:{identity.user_id}", settings.rate_limit_parse_per_min)

    body = await request.json()
    image_url = body.get("imageUrl") if isinstance(body, dict) else None
    if not isinstance(image_url, str) or not image_url.startswith("https://"):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "imageUrl (https) is required — upload the menu photo first",
        )
    if len(image_url) > 600:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "imageUrl too long")

    try:
        return await create_parse_draft(image_url)
    except VisionError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc))


@router.post("/bulk", response_model=BulkPublishResult)
async def bulk_publish(
    request: BulkPublishRequest,
    identity: Identity = Depends(require_user),
    cookie_header: str = Depends(get_cookie_header),
) -> BulkPublishResult:
    """Owner-verified items → restaurant service → MongoDB (single batch).

    Authorization is enforced by the restaurant service against the
    forwarded seller session — this service cannot mint menu rows for a
    restaurant the caller doesn't own.
    """
    await enforce_rate_limit(f"menu-parser-bulk:{identity.user_id}", settings.rate_limit_parse_per_min)

    from app.core.resilience import BreakerOpen, internal_post

    try:
        data = await internal_post(
            f"{settings.restaurant_service_url}/api/menu-item/bulk",
            json_body=request.model_dump(by_alias=True, mode="json"),
            headers={"cookie": cookie_header},
        )
    except BreakerOpen as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "menu service busy — retry shortly") from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"menu service error: {exc}") from exc

    if not isinstance(data, dict) or not data.get("success"):
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "bulk publish rejected by menu service")

    return BulkPublishResult(
        created=int(data.get("created", 0)),
        skipped=list(data.get("skipped", [])),
        restaurant_id=request.restaurant_id,
    )
