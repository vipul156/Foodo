"""Authentication parity with the Node services (same as ai-commerce).

Verifies the SAME `session` cookie (cookie-session envelope + access
JWT) with the SAME secrets — one identity plane across the platform.

The verification itself lives in ``pycommon.security``; this file only
binds it to this service's secrets.
"""

from __future__ import annotations

from pycommon.security import Identity, SessionVerifier, internal_headers  # noqa: F401

from app.core.config import get_settings

settings = get_settings()

verifier = SessionVerifier(
    jwt_secret=settings.jwt_secret,
    cookie_secret=settings.cookie_secret,
)

require_user = verifier.require_user
optional_user = verifier.optional_user


def service_headers() -> dict[str, str]:
    """Internal-key headers for sibling-service calls (x-internal-key)."""
    return internal_headers(settings.internal_service_key)
