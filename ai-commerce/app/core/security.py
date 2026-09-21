"""Authentication parity with the Node services.

The browser authenticates against the existing auth service (cookie-session
carrying the short-lived access JWT). This service never logs anyone in —
it verifies the SAME session cookie with the SAME secret, keeping one
identity plane across the platform.

Cookie-session (cookie-session npm) serializes payloads as
`<base64-body>.<hmac-sha256>`; body is `{"jwt": "<token>"}`.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Any

import jwt
from fastapi import Depends, HTTPException, Request, status

from app.core.config import get_settings

settings = get_settings()

SESSION_COOKIE = "session"


class Identity:
    """Verified caller — mirrors the Node `req.user` shape (sub + role)."""

    def __init__(self, sub: str, role: str, expires_at: float) -> None:
        self.sub = sub
        self.role = role
        self.expires_at = expires_at

    @property
    def user_id(self) -> str:
        return self.sub


def _unsign_cookie_session(raw: str) -> dict[str, Any] | None:
    """Verify and decode a cookie-session value (body.hmac-sha256)."""
    if "." not in raw:
        return None
    body_b64, sig = raw.rsplit(".", 1)
    expected = base64.urlsafe_b64encode(
        hmac.new(
            settings.cookie_secret.encode(), body_b64.encode(), hashlib.sha256
        ).digest()
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
    # Dev/fallback: Authorization header (Bearer) — used by API tooling.
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return None


def _verify(token: str) -> Identity:
    try:
        payload = jwt.decode(
            token, settings.jwt_secret, algorithms=["HS256"], options={"require": ["exp", "sub"]}
        )
    except jwt.PyJWTError:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, "Unauthorized"
        )
    if payload.get("typ") != "access" or payload.get("sub") is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Unauthorized")
    return Identity(
        sub=str(payload["sub"]),
        role=str(payload.get("role", "")),
        expires_at=float(payload.get("exp", 0)),
    )


async def require_user(request: Request) -> Identity:
    """FastAPI dependency — fail-closed identity for every user route."""
    token = _extract_jwt(request)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Unauthorized")
    identity = _verify(token)
    if identity.expires_at < time.time():
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired")
    return identity


async def optional_user(request: Request) -> Identity | None:
    token = _extract_jwt(request)
    if not token:
        return None
    try:
        return _verify(token)
    except HTTPException:
        return None


def service_headers() -> dict[str, str]:
    """Internal-key headers for sibling-service calls (x-internal-key)."""
    return {"x-internal-key": settings.internal_service_key}


# Dependency aliases (import style used by routers)
user_dep = Depends(require_user)
