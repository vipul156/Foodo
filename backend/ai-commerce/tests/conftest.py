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

from pycommon.testing import seed_test_env

seed_test_env(
    JWT_SECRET="test-jwt-secret",
    COOKIE_SECRET="test-cookie-secret",
)
