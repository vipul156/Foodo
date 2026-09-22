"""Authentication parity with the Node services (same as ai-commerce).

Verifies the SAME `session` cookie (cookie-session envelope + access
JWT) with the SAME secrets — one identity plane across the platform.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Any

import jwt
from fastapi import HTTPException, Request, status

from app.core.config import get_settings

settings = get_settings()

SESSION_COOKIE = "session"


class Identity:
    def __init__(self, sub: str, role: str, expires_at: float) -> None:
        self.sub = sub
        self.role = role
        self.expires_at = expires_at

    @property
    def user_id(self) -> str:
        return self.sub


def _unsign_cookie_session(raw: str) -> dict[str, Any] | None:
    if "." not in raw:
        return None
    body_b64, sig = raw.rsplit(".", 1)
    expected = base64.urlsafe_b64encode(
        hmac.new(settings.cookie_secret.encode(), body_b64.encode(), hashlib.sha256).digest()
    ).decode().rstrip("=")
    if not hmac.compare_digest(sig, expected):
        return None
    pad = "=" * (-len(body_b64) % 4)
    try:
        body = json.loads(base64.urlsafe_b64decode(body_b64 + pad))
    except Exception:
        return None
    return body if isinstance(body, dict) else None


def _extract_jwt(request: Request) -> str | None:
    raw = request.cookies.get(SESSION_COOKIE)
    if raw:
        session = _unsign_cookie_session(raw)
        if isinstance(session, dict) and isinstance(session.get("jwt"), str):
            return session["jwt"]
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return None


def _verify(token: str) -> Identity:
    try:
        payload = jwt.decode(
            token,
            settings.jwt_secret,
            algorithms=["HS256"],
            options={"require": ["exp", "sub"]},
        )
    except jwt.PyJWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Unauthorized")
    if payload.get("typ") != "access" or payload.get("sub") is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Unauthorized")
    return Identity(
        sub=str(payload["sub"]),
        role=str(payload.get("role", "")),
        expires_at=float(payload.get("exp", 0)),
    )


async def require_user(request: Request) -> Identity:
    token = _extract_jwt(request)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Unauthorized")
    identity = _verify(token)
    if identity.expires_at < time.time():
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired")
    return identity


def service_headers() -> dict[str, str]:
    return {"x-internal-key": settings.internal_service_key}
