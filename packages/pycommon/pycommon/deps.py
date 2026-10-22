"""Shared FastAPI dependencies.

The cookie_header dependency extracts the raw Cookie header so platform
clients can present the USER's session to cookie-authenticated sibling
endpoints server-side. This preserves the platform's single identity
plane: an AI service acts only for the user whose session it can
cryptographically present.
"""

from __future__ import annotations

from fastapi import Request


def get_cookie_header(request: Request) -> str:
    """Raw Cookie header for server-side forwarding (empty when absent)."""
    return request.headers.get("cookie", "")
