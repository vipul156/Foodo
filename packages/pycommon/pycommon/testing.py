"""Test bootstrap helpers — shared fail-closed secret seeding.

Several modules build ``Settings()`` at import scope and the services
deliberately refuse to construct without their secrets — the unit tests
exercise pure logic (pricing, dispatch policy, parsing) and must not be
blocked by that. Seeding throwaway values keeps the production validators
intact instead of weakening them for tests.
"""

from __future__ import annotations

import os

#: Secrets every service needs to construct its settings.
BASE_TEST_ENV: dict[str, str] = {
    "INTERNAL_SERVICE_KEY": "test-internal-service-key",
    # boto3 needs a region to build a client (tests never leave the process).
    "AWS_REGION": "ap-south-1",
    "AWS_DEFAULT_REGION": "ap-south-1",
}


def seed_test_env(**overrides: str) -> None:
    """Seed throwaway secrets so fail-closed settings can construct.

    ``setdefault`` means a real environment value always wins; these are
    only fallbacks for a developer/CI machine with no ``.env``.
    """
    for key, value in {**BASE_TEST_ENV, **overrides}.items():
        os.environ.setdefault(key, value)
