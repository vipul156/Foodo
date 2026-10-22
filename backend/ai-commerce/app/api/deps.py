"""Shared FastAPI dependencies.

The cookie_header dependency extracts the raw Cookie header so the
platform client can present the USER's session to cookie-authenticated
restaurant-service endpoints server-side. This preserves the platform's
single identity plane: the AI service acts only for the user whose
session it can cryptographically present.
"""

from __future__ import annotations

from functools import lru_cache

from pycommon.deps import get_cookie_header  # noqa: F401 (re-export)

from app.clients.platform import PlatformClient


@lru_cache
def _platform() -> PlatformClient:
    return PlatformClient()


def get_platform() -> PlatformClient:
    return _platform()
