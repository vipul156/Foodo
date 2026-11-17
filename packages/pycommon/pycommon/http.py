"""Lambda HTTP entrypoint — Mangum wraps the FastAPI app.

The Python analog of the TS tier's ``serverless-http`` handler: one
adapter, configured the same way in every service.
"""

from __future__ import annotations

from fastapi import FastAPI
from mangum import Mangum


def lambda_handler(app: FastAPI) -> Mangum:
    """Wrap a FastAPI app for AWS Lambda (API Gateway payload v2)."""
    return Mangum(app, lifespan="auto")
