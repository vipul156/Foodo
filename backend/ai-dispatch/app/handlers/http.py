"""Lambda HTTP entrypoint — Mangum wraps the FastAPI ops surface.

The real dispatch intake is the SQS consumer (handlers.dispatchConsumer);
this handler serves only the observability endpoints (snapshot, simulate,
health) behind the shared API Gateway.
"""

from mangum import Mangum

from app.main import app

handler = Mangum(app, lifespan="auto")
