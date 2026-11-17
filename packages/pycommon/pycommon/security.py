"""Session verification — one identity plane across the platform.

The browser authenticates against the existing auth service (cookie-session
carrying the short-lived access JWT). The AI services never log anyone in —
they verify the SAME session cookie with the SAME secret.

Cookie-session (cookie-session npm) is the transport. Its exact wire
format is what this module has to match, byte for byte:

* The BODY is ``Buffer.toString('base64')`` of the JSON payload
  (standard base64, ``=`` padded) — ``{"jwt": "<token>"}``.
* The SIGNATURE is a separate cookie, ``<name>.sig``, holding
  ``keygrip``'s digest: ``HMAC-SHA1(COOKIE_SECRET, body)`` in base64,
  then ``/``→``_``, ``+``→``-`` and ``=`` stripped (base64URL).

So cookie-session 2.x (what the auth-service ships) puts TWO cookies on
the wire — ``session`` and ``session.sig`` — not one combined value.
cookie-session 1.x combined them into a single ``session`` cookie of the
form ``<body>.<sig>`` signed with ``cookie-signature`` (HMAC-SHA256,
standard base64). Both layouts are accepted here; both fail closed.

Getting this wrong is silent and total: a verifier that expects a
combined value simply never matches, and every browser request is
rejected with a 401 that looks like a missing session rather than a
format mismatch.
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

SESSION_COOKIE = "session"
#: cookie-session 2.x ships the signature as its own cookie alongside
#: the body (``session`` + ``session.sig``).
SESSION_SIG_COOKIE = "session.sig"


class Identity:
    """Verified caller — mirrors the Node `req.user` shape (sub + role)."""

    def __init__(self, sub: str, role: str, expires_at: float) -> None:
        self.sub = sub
        self.role = role
        self.expires_at = expires_at

    @property
    def user_id(self) -> str:
        return self.sub


class SessionVerifier:
    """Verifies the platform's cookie-session + access JWT.

    Fail-closed throughout: a missing secret, a bad signature, a missing
    token and an expired token all end in a 401 — never in a caller.
    """

    def __init__(self, *, jwt_secret: str, cookie_secret: str) -> None:
        self._jwt_secret = jwt_secret
        self._cookie_secret = cookie_secret

    def _keygrip_signature(self, body: str, name: str = SESSION_COOKIE) -> str:
        """The signature cookie-session 2.x actually writes.

        ``cookies`` 0.9.1 signs ``"<name>=<value>"`` — the cookie NAME is
        part of the signed string — using keygrip 1.1.0's defaults:
        HMAC-**SHA1**, base64 encoded, then rewritten ``/``→``_``,
        ``+``→``-`` and ``=`` stripped.
        """
        digest = hmac.new(
            self._cookie_secret.encode(), f"{name}={body}".encode(), hashlib.sha1
        ).digest()
        return base64.urlsafe_b64encode(digest).decode().rstrip("=")

    def _cookie_signature_signature(self, body: str) -> str:
        """The signature cookie-session 1.x wrote (cookie-signature).

        HMAC-SHA256 over the body, STANDARD base64, ``=`` padding
        stripped — the legacy combined ``<body>.<sig>`` layout.
        """
        digest = hmac.new(
            self._cookie_secret.encode(), body.encode(), hashlib.sha256
        ).digest()
        return base64.b64encode(digest).decode().rstrip("=")

    @staticmethod
    def _decode_body(body_b64: str) -> dict[str, Any] | None:
        """Decode the base64 JSON payload. Never raises."""
        pad = "=" * (-len(body_b64) % 4)
        for decoder in (base64.b64decode, base64.urlsafe_b64decode):
            try:
                body = json.loads(decoder(body_b64 + pad))
            except Exception:
                continue
            if isinstance(body, dict):
                return body
        return None

    def verify_session_cookie(
        self, body_raw: str, sig_raw: str | None = None
    ) -> dict[str, Any] | None:
        """Verify + decode a cookie-session pair.

        ``sig_raw`` is the value of the ``session.sig`` cookie
        (cookie-session 2.x). When it is absent the body is treated as
        the legacy combined ``<body>.<sig>`` value (cookie-session 1.x).
        Returns the decoded payload, or ``None`` if anything fails.
        """
        if not body_raw:
            return None

        if sig_raw:
            # 2.x — split pair: the signature cookie covers the body.
            if not hmac.compare_digest(sig_raw, self._keygrip_signature(body_raw)):
                return None
            return self._decode_body(body_raw)

        # 1.x — combined value: cookie-signature signs the body VALUE
        # alone (no name prefix) with HMAC-SHA256.
        if "." not in body_raw:
            return None
        body_b64, sig = body_raw.rsplit(".", 1)
        if not hmac.compare_digest(sig, self._cookie_signature_signature(body_b64)):
            return None
        return self._decode_body(body_b64)

    def unsign_cookie_session(self, raw: str) -> dict[str, Any] | None:
        """Verify and decode a cookie-session value.

        Handles the combined ``<body>.<sig>`` layout (cookie-session 1.x).
        For the split 2.x layout use :meth:`verify_session_cookie` with the
        ``session.sig`` cookie value.
        """
        return self.verify_session_cookie(raw)

    def extract_jwt(self, request: Request) -> str | None:
        """Pull the access JWT out of the session cookie or Bearer header."""
        raw = request.cookies.get(SESSION_COOKIE)
        if raw:
            session = self.verify_session_cookie(
                raw, request.cookies.get(SESSION_SIG_COOKIE)
            )
            if isinstance(session, dict) and isinstance(session.get("jwt"), str):
                return session["jwt"]
        # Dev/fallback: Authorization header (Bearer) — used by API tooling.
        auth = request.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            return auth[7:].strip()
        return None

    def verify(self, token: str) -> Identity:
        if not self._jwt_secret or not self._cookie_secret:
            # Misconfiguration, not a bad token — surface it as a server
            # error so it is never mistaken for a rejected caller.
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                "Session verification is not configured",
            )
        try:
            payload = jwt.decode(
                token,
                self._jwt_secret,
                algorithms=["HS256"],
                options={"require": ["exp", "sub"]},
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

    async def require_user(self, request: Request) -> Identity:
        """FastAPI dependency — fail-closed identity for every user route."""
        token = self.extract_jwt(request)
        if not token:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Unauthorized")
        identity = self.verify(token)
        if identity.expires_at < time.time():
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired")
        return identity

    async def optional_user(self, request: Request) -> Identity | None:
        """FastAPI dependency — the caller when valid, None otherwise."""
        token = self.extract_jwt(request)
        if not token:
            return None
        try:
            return self.verify(token)
        except HTTPException:
            return None


def internal_headers(internal_service_key: str) -> dict[str, str]:
    """Internal-key headers for sibling-service calls (x-internal-key)."""
    return {"x-internal-key": internal_service_key}
