"""Test bootstrap — inject the fail-closed secrets BEFORE app import.

`app.core.security`, `app.clients.platform` and friends build `Settings()`
at module scope, and the service refuses to construct without its secrets —
session cookies and internal calls are fail-closed in production. The unit
tests here exercise pure logic (pricing, menu ranking, draft mutations) and
must not be blocked by that, so we seed throwaway values instead of
weakening the production validators.

`setdefault` means a real environment value always wins; these are only
fallbacks for a developer/CI machine with no `.env`.
"""

import os

os.environ.setdefault("INTERNAL_SERVICE_KEY", "test-internal-service-key")
os.environ.setdefault("JWT_SECRET", "test-jwt-secret")
os.environ.setdefault("COOKIE_SECRET", "test-cookie-secret")

# boto3 needs a region to build a client (tests never leave the process).
os.environ.setdefault("AWS_REGION", "ap-south-1")
os.environ.setdefault("AWS_DEFAULT_REGION", "ap-south-1")
