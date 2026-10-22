"""Test bootstrap — inject the fail-closed secrets BEFORE app import.

`app.core.security` and `app.clients.gemini` build `Settings()` at module
scope, and the service refuses to construct without its secrets — internal
calls are fail-closed and the Gemini key must never be missing in
production. The unit tests here exercise pure parsing/normalization code
and must not be blocked by that, so we seed throwaway values instead of
weakening the production validators.

`setdefault` means a real environment value always wins; these are only
fallbacks for a developer/CI machine with no `.env`.
"""

from pycommon.testing import seed_test_env

seed_test_env(GEMINI_API_KEY="test-gemini-api-key")
