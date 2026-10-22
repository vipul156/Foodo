"""Shared FastAPI dependencies (identity parity with ai-commerce)."""

from __future__ import annotations

from pycommon.deps import get_cookie_header  # noqa: F401 (re-export)

from app.core.security import Identity, require_user  # noqa: F401 (re-export)
