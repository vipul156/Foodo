"""Test bootstrap — inject the fail-closed secrets BEFORE app import.

Several modules build `Settings()` at import time (and `app.core.resilience`
does it at module scope), while the service deliberately refuses to construct
without `INTERNAL_SERVICE_KEY` — dispatch actions are fail-closed in
production. The unit tests here exercise pure policy code and must not be
blocked by that, so we seed throwaway values instead of weakening the
production validator.

`setdefault` means a real environment value always wins; these are only
fallbacks for a developer/CI machine with no `.env`.
"""

from pycommon.testing import seed_test_env

seed_test_env()
