"""Shared FastAPI dependencies (identity parity with ai-commerce)."""

from __future__ import annotations

from fastapi import Request

from app.core.security import Identity, require_user  # noqa: F401 (re-export)


def get_cookie_header(request: Request) -> str:
    return request.headers.get("cookie", "")
