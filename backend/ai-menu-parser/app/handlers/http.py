"""Lambda HTTP entrypoint — Mangum wraps the FastAPI parse surface.

Stateless service: no tables of its own (rate limiting counters are the
shared rate-limits table). The gateway JWT authorizer protects
/api/menu-parser/*; in-app require_user re-verifies the same session.
"""

from mangum import Mangum

from app.main import app

handler = Mangum(app, lifespan="auto")
