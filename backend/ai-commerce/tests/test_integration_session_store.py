"""Integration test — the commerce session store against a real DynamoDB.

The session item IS the checkout draft, and a draft carries prices —
floats. DynamoDB has no float type, so a float anywhere in the item
fails the WHOLE write. That failure is silent from the caller's side
(the store is fire-and-forget about it), which means a user's draft can
vanish between turns while the UI still shows it.

moto gives the REAL boto3 DynamoDB resource API, so these tests exercise
the actual serializer rather than a hand-written fake of it.

The last test drives the real HTTP route with a real signed session
cookie, proving the round-trip end to end: draft in DynamoDB → Decimal
out of DynamoDB → JSON out of the API.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Any

import boto3
import jwt
import pytest
from moto import mock_aws

SESSIONS_TABLE = "foodo-commerce-sessions"
REGION = "ap-south-1"

#: conftest seeds these for the fail-closed settings.
JWT_SECRET = "test-jwt-secret"
COOKIE_SECRET = "test-cookie-secret"

ITEM_ID = "a" * 24  # ObjectIdStr — 24 hex chars


# ─── AWS fixture ─────────────────────────────────────────────────


@pytest.fixture()
def ddb(monkeypatch):
    """A moto-backed DynamoDB with the sessions table and its GSI."""
    import pycommon.aws as aws_mod

    monkeypatch.setenv("AWS_REGION", REGION)
    monkeypatch.setenv("AWS_DEFAULT_REGION", REGION)
    monkeypatch.setenv("COMMERCE_SESSIONS_TABLE", SESSIONS_TABLE)

    with mock_aws():
        aws_mod._resource = aws_mod._sns = aws_mod._sqs = None
        try:
            boto3.client("dynamodb", region_name=REGION).create_table(
                TableName=SESSIONS_TABLE,
                KeySchema=[
                    {"AttributeName": "pk", "KeyType": "HASH"},
                    {"AttributeName": "sk", "KeyType": "RANGE"},
                ],
                AttributeDefinitions=[
                    {"AttributeName": "pk", "AttributeType": "S"},
                    {"AttributeName": "sk", "AttributeType": "S"},
                    {"AttributeName": "userId", "AttributeType": "S"},
                    {"AttributeName": "updatedAt", "AttributeType": "S"},
                ],
                GlobalSecondaryIndexes=[
                    {
                        "IndexName": "user-index",
                        "KeySchema": [
                            {"AttributeName": "userId", "KeyType": "HASH"},
                            {"AttributeName": "updatedAt", "KeyType": "RANGE"},
                        ],
                        "Projection": {"ProjectionType": "ALL"},
                    }
                ],
                BillingMode="PAY_PER_REQUEST",
            )
            yield
        finally:
            aws_mod._resource = aws_mod._sns = aws_mod._sqs = None


# ─── Helpers ─────────────────────────────────────────────────────


def _draft(**overrides: Any) -> dict[str, Any]:
    """A realistic draft: one line with a price, plus the price breakdown."""
    draft = {
        "restaurant_id": "rest-1",
        "restaurant_name": "Truffle Kitchen",
        "lines": [
            {
                "item_id": ITEM_ID,
                "name": "Paneer Tikka",
                "unit_price": 249.5,
                "quantity": 2,
                "customizations": ["extra paneer"],
            }
        ],
        "pricing": {
            "subtotal": 499.0,
            "delivery_fee": 0.0,
            "platform_fee": 7.0,
            "total": 506.0,
            "currency": "INR",
        },
        "ready_to_pay": True,
        "requires_auth": True,
    }
    draft.update(overrides)
    return draft


def _scratch(draft: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"draft": draft or {"lines": []}, "history": []}


def _session_cookie(user_id: str) -> tuple[str, str]:
    """A real cookie-session 2.x pair: (session, session.sig).

    Same wire format the auth service writes — base64 body plus a
    keygrip HMAC-SHA1 over ``"session=<body>"``.
    """
    token = jwt.encode(
        {
            "sub": user_id,
            "role": "customer",
            "typ": "access",
            "exp": int(time.time()) + 900,
        },
        JWT_SECRET,
        algorithm="HS256",
    )
    body = base64.b64encode(json.dumps({"jwt": token}).encode()).decode()
    digest = hmac.new(
        COOKIE_SECRET.encode(), f"session={body}".encode(), hashlib.sha1
    ).digest()
    sig = base64.urlsafe_b64encode(digest).decode().rstrip("=")
    return body, sig


# ─── The store ───────────────────────────────────────────────────


async def test_a_session_is_created_and_read_back(ddb) -> None:
    from app.services.session_store import SessionStore

    store = SessionStore()
    doc = await store.create("user-1")

    assert doc["session_id"]
    stored = await store.get("user-1", doc["session_id"])
    assert stored is not None
    assert stored["session_id"] == doc["session_id"]
    assert stored["expiresAt"] > 0  # the TTL the IaC sweeps on


async def test_a_draft_with_prices_persists(ddb) -> None:
    """THE bug: a float anywhere in the item fails the whole write.

    Prices are floats, so before the Decimal cast every save of a
    non-empty draft raised and the user's cart was lost between turns.
    """
    from app.services.session_store import SessionStore

    store = SessionStore()
    doc = await store.create("user-1")

    await store.save(
        "user-1",
        doc["session_id"],
        draft=_draft(),
        history=[{"role": "user", "content": "two paneer tikka"}],
        scratch=_scratch(_draft()),
    )

    stored = await store.get("user-1", doc["session_id"])
    assert stored is not None
    lines = stored["draft"]["lines"]
    assert len(lines) == 1
    assert lines[0]["name"] == "Paneer Tikka"
    assert lines[0]["quantity"] == 2
    # DynamoDB returns numbers as Decimal — that is the point.
    assert float(lines[0]["unit_price"]) == 249.5
    assert float(stored["draft"]["pricing"]["total"]) == 506.0
    assert stored["history"] == [{"role": "user", "content": "two paneer tikka"}]


async def test_the_saved_draft_still_builds_a_checkout_card(ddb) -> None:
    """The read path must survive the Decimal round-trip."""
    from app.services.orchestrator import Orchestrator
    from app.services.session_store import SessionStore

    store = SessionStore()
    doc = await store.create("user-1")
    await store.save(
        "user-1",
        doc["session_id"],
        draft=_draft(),
        history=[],
        scratch=_scratch(_draft()),
    )

    stored = await store.get("user-1", doc["session_id"])
    card = Orchestrator._build_checkout_card(Orchestrator, stored["scratch"])

    assert card is not None
    assert card.ready_to_pay is True
    assert card.requires_auth is True
    assert card.lines[0].unit_price == 249.5
    assert card.pricing.total == 506.0
    assert card.pricing.currency == "INR"


async def test_sessions_are_listed_newest_first(ddb) -> None:
    from app.services.session_store import SessionStore

    store = SessionStore()
    first = await store.create("user-1")
    second = await store.create("user-1")
    await store.save(
        "user-1",
        second["session_id"],
        draft=_draft(),
        history=[],
        scratch=_scratch(_draft()),
    )

    sessions = list(await store.list_for_user("user-1"))
    assert len(sessions) == 2
    assert sessions[0]["session_id"] == second["session_id"]
    assert sessions[1]["session_id"] == first["session_id"]
    assert bool(sessions[0]["draft"]["lines"]) is True
    assert bool(sessions[1]["draft"]["lines"]) is False


async def test_a_session_is_deleted(ddb) -> None:
    from app.services.session_store import SessionStore

    store = SessionStore()
    doc = await store.create("user-1")

    assert await store.delete("user-1", doc["session_id"]) == 1
    assert await store.get("user-1", doc["session_id"]) is None
    # Deleting twice is not an error, just a no-op.
    assert await store.delete("user-1", doc["session_id"]) == 0


# ─── Through the real route ──────────────────────────────────────


def test_the_draft_route_returns_the_saved_prices(ddb) -> None:
    """End to end: DynamoDB → Decimal → JSON, through the real route.

    A Decimal that leaks into the response would 500 here, so this
    proves the whole write/read/encode loop.
    """
    import asyncio

    from fastapi.testclient import TestClient

    from app.main import app
    from app.services.session_store import SessionStore

    store = SessionStore()
    doc = asyncio.get_event_loop().run_until_complete(store.create("user-1"))
    asyncio.get_event_loop().run_until_complete(
        store.save(
            "user-1",
            doc["session_id"],
            draft=_draft(),
            history=[],
            scratch=_scratch(_draft()),
        )
    )

    body, sig = _session_cookie("user-1")
    client = TestClient(app)
    client.cookies.set("session", body)
    client.cookies.set("session.sig", sig)

    resp = client.get(f"/api/commerce/draft?session_id={doc['session_id']}")
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["success"] is True
    line = payload["draft"]["lines"][0]
    assert line["name"] == "Paneer Tikka"
    assert line["unit_price"] == 249.5
    assert payload["draft"]["pricing"]["total"] == 506.0


def test_the_draft_route_stays_closed_without_a_session(ddb) -> None:
    from fastapi.testclient import TestClient

    from app.main import app

    client = TestClient(app)
    resp = client.get("/api/commerce/draft?session_id=whatever")
    assert resp.status_code == 401
