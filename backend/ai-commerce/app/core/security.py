"""Authentication parity with the Node services.

The browser authenticates against the existing auth service (cookie-session
carrying the short-lived access JWT). This service never logs anyone in —
it verifies the SAME session cookie with the SAME secret, keeping one
identity plane across the platform.

Cookie-session (cookie-session npm) serializes payloads as
`<base64-body>.<hmac-sha256>`; body is `{"jwt": "<token>"}`.

The verification itself lives in ``pycommon.security``; this file only
binds it to this service's secrets.
"""

from __future__ import annotations

from fastapi import Depends

from pycommon.security import Identity, SessionVerifier, internal_headers  # noqa: F401

from app.core.config import get_settings

settings = get_settings()

verifier = SessionVerifier(
    jwt_secret=settings.jwt_secret,
    cookie_secret=settings.cookie_secret,
)

require_user = verifier.require_user
optional_user = verifier.optional_user

# Dependency aliases (import style used by routers)
user_dep = Depends(require_user)


def service_headers() -> dict[str, str]:
    """Internal-key headers for sibling-service calls (x-internal-key)."""
    return internal_headers(settings.internal_service_key)
