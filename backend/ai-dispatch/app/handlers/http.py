"""Lambda HTTP entrypoint — Mangum wraps the FastAPI ops surface.

The real dispatch intake is the SQS consumer (handlers.dispatchConsumer);
this handler serves only the observability endpoints (snapshot, simulate,
health) behind the shared API Gateway.
"""

from pycommon.http import lambda_handler

from app.main import app

handler = lambda_handler(app)
