"""Lambda HTTP entrypoint — Mangum wraps the FastAPI commerce surface.

Every /api/commerce route enforces the user session in-app (require_user);
the gateway authorizer blocks unauthenticated traffic before the
container boots. No queue consumers: this service is pure HTTP.
"""

from mangum import Mangum

from app.main import app

handler = Mangum(app, lifespan="auto")
