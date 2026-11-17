"""Integration test — the dispatch swarm against a real DynamoDB + SNS.

moto stands in for AWS with the REAL boto3 DynamoDB resource API and the
REAL SNS publish path, so the parts of the swarm that only a live
integration can prove are genuinely exercised:

  * the idempotency claim (conditional PutItem) that makes the
    at-least-once SQS source safe to retry,
  * the cross-time batching pool (Query / PutItem / DeleteItem),
  * the order + rider enrichment reads,
  * the SNS decision fanout and its ``event`` MessageAttribute,
  * the SQS consumer wiring and its partial-failure redrive,
  * the ops HTTP surface (snapshot / simulate) behind the internal key.

Only the HTTP egress is faked (the sibling services and the weather API
— neither of which exists in CI); the AWS API is NOT. The unit tests
cover the pure policy functions; this file covers the wiring, the
DynamoDB state machine and the fanout, which is where the two halves
have to agree.
"""

from __future__ import annotations

import json
from decimal import Decimal
from typing import Any

import boto3
import pytest
from moto import mock_aws

STATE_TABLE = "foodo-dispatch-state"
ORDERS_TABLE = "foodo-orders"
RIDERS_TABLE = "foodo-riders"
TOPIC_NAME = "foodo-events"
QUEUE_NAME = "dispatch-events"

#: GeoJSON Point for the restaurant pickup — [lng, lat], Bengaluru.
PICKUP: dict[str, Any] = {"type": "Point", "coordinates": [77.5946, 12.9716]}

REGION = "ap-south-1"


# ─── AWS helpers ─────────────────────────────────────────────────


def _ddb():
    return boto3.resource("dynamodb", region_name=REGION)


def _sns():
    return boto3.client("sns", region_name=REGION)


def _sqs():
    return boto3.client("sqs", region_name=REGION)


def _seed_order(
    order_id: str,
    *,
    restaurant_id: str = "rest-1",
    drop_lat: float = 12.9800,
    drop_lng: float = 77.6000,
    items: tuple[str, ...] = ("Paneer Tikka", "Masala Chai"),
) -> None:
    _ddb().Table(ORDERS_TABLE).put_item(
        Item={
            "pk": f"ORDER#{order_id}",
            "sk": "ORDER",
            "restaurantId": restaurant_id,
            "status": "ready",
            "items": [{"name": name, "quantity": 1} for name in items],
            # DynamoDB has no float type — the platform writes coordinates
            # as Decimal, and so must the fixture.
            "deliveryAddress": {
                "latitude": Decimal(str(drop_lat)),
                "longitude": Decimal(str(drop_lng)),
            },
        }
    )


def _seed_rider(
    rider_id: str,
    *,
    lat: float = 12.9720,
    lng: float = 77.5950,
    available: bool = True,
    verified: bool = True,
) -> None:
    _ddb().Table(RIDERS_TABLE).put_item(
        Item={
            "pk": f"RIDER#{rider_id}",
            "sk": "RIDER",
            "id": rider_id,
            "userId": f"user-{rider_id}",
            "name": f"Rider {rider_id}",
            "phoneNumber": "+919999999999",
            "isAvailable": available,
            "isVerified": verified,
            "location": {"coordinates": [Decimal(str(lng)), Decimal(str(lat))]},
        }
    )


def _claim_row(order_id: str) -> dict[str, Any] | None:
    return (
        _ddb()
        .Table(STATE_TABLE)
        .get_item(Key={"pk": f"READY#{order_id}", "sk": "SEEN"})
        .get("Item")
    )


def _pool_rows(restaurant_id: str) -> list[dict[str, Any]]:
    response = _ddb().Table(STATE_TABLE).query(
        KeyConditionExpression="pk = :pool",
        ExpressionAttributeValues={":pool": f"POOL#{restaurant_id}"},
    )
    return response.get("Items", [])


def _received(queue_url: str) -> list[dict[str, Any]]:
    """Every SNS notification delivered to the queue, oldest first."""
    out: list[dict[str, Any]] = []
    while True:
        response = _sqs().receive_message(
            QueueUrl=queue_url, MaxNumberOfMessages=10, WaitTimeSeconds=0
        )
        messages = response.get("Messages", [])
        if not messages:
            return out
        for message in messages:
            out.append(json.loads(message["Body"]))
            _sqs().delete_message(
                QueueUrl=queue_url, ReceiptHandle=message["ReceiptHandle"]
            )


def _decisions(queue_url: str) -> list[dict[str, Any]]:
    """The decision payloads out of the SNS notifications."""
    return [
        json.loads(notification["Message"])["payload"]
        for notification in _received(queue_url)
        if json.loads(notification["Message"])["event"] == "dispatch.decision"
    ]


# ─── Fixtures ────────────────────────────────────────────────────


@pytest.fixture()
def aws(monkeypatch):
    """A moto-backed AWS with the service's real tables, topic and queue.

    The tables, the topic ARN and the subscription are the same objects
    the Lambda environment gets from IaC — only the AWS endpoint differs.
    """
    import pycommon.aws as aws_mod

    monkeypatch.setenv("AWS_REGION", REGION)
    monkeypatch.setenv("AWS_DEFAULT_REGION", REGION)
    monkeypatch.setenv("DISPATCH_STATE_TABLE", STATE_TABLE)
    monkeypatch.setenv("ORDERS_TABLE", ORDERS_TABLE)
    monkeypatch.setenv("RIDERS_TABLE", RIDERS_TABLE)

    with mock_aws():
        # pycommon.aws caches its clients for the lifetime of a warm
        # container. The mock must own them, so drop the cache on both
        # sides of the context.
        aws_mod._resource = aws_mod._sns = aws_mod._sqs = None
        try:
            client = _ddb().meta.client
            for name in (STATE_TABLE, ORDERS_TABLE, RIDERS_TABLE):
                client.create_table(
                    TableName=name,
                    KeySchema=[
                        {"AttributeName": "pk", "KeyType": "HASH"},
                        {"AttributeName": "sk", "KeyType": "RANGE"},
                    ],
                    AttributeDefinitions=[
                        {"AttributeName": "pk", "AttributeType": "S"},
                        {"AttributeName": "sk", "AttributeType": "S"},
                    ],
                    BillingMode="PAY_PER_REQUEST",
                )

            arn = _sns().create_topic(Name=TOPIC_NAME)["TopicArn"]
            monkeypatch.setenv("EVENTS_TOPIC_ARN", arn)

            # A queue subscribed to the topic — the same shape the
            # platform's consumers bind (SNS → SQS with a FilterPolicy
            # on the `event` MessageAttribute).
            queue_url = _sqs().create_queue(QueueName=QUEUE_NAME)["QueueUrl"]
            queue_arn = _sqs().get_queue_attributes(
                QueueUrl=queue_url, AttributeNames=["QueueArn"]
            )["Attributes"]["QueueArn"]
            _sns().subscribe(
                TopicArn=arn,
                Protocol="sqs",
                Endpoint=queue_arn,
                Attributes={"RawMessageDelivery": "false"},
            )
            yield {"topic_arn": arn, "queue_url": queue_url}
        finally:
            aws_mod._resource = aws_mod._sns = aws_mod._sqs = None


@pytest.fixture()
def egress(monkeypatch):
    """Stub the two network dependencies: the sibling HTTP API + weather.

    Everything AWS-side stays real; only the outbound HTTP is faked so
    the test never touches the network and stays deterministic.
    """
    from app.agents import weather_agent
    from app.core import resilience as resilience_mod

    weather_agent._cache.clear()

    class _Response:
        def __init__(self, payload: dict[str, Any]) -> None:
            self._payload = payload

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, Any]:
            return self._payload

    async def _fake_request(method: str, url: str, **kwargs: Any) -> _Response:
        if url.endswith("/api/internal/restaurants/stats"):
            return _Response({"active": 3})
        return _Response({})

    async def _fake_get(url: str, **kwargs: Any) -> _Response:
        # WMO 95 = thunderstorm, 40 km/h wind → the agent's own mapping
        # must turn this into a 25-minute pad and a 35 rupee surge.
        return _Response(
            {"current": {"weather_code": 95, "wind_speed_10m": 40.0}}
        )

    monkeypatch.setattr(resilience_mod.pools.internal, "request", _fake_request)
    monkeypatch.setattr(weather_agent.pools.weather, "get", _fake_get)
    return resilience_mod


@pytest.fixture(autouse=True)
def _fresh_service():
    """The dispatch service is a warm-container singleton — reset it."""
    import app.services.dispatch_service as dispatch_service

    dispatch_service._service = None
    yield
    dispatch_service._service = None


def _ready_payload(order_id: str, *, restaurant_id: str = "rest-1") -> dict[str, Any]:
    return {
        "orderId": order_id,
        "restaurantId": restaurant_id,
        "location": PICKUP,
    }


# ─── The happy path ──────────────────────────────────────────────


async def test_ready_event_assigns_a_rider_and_publishes_the_decision(
    aws, egress
) -> None:
    """One ready order → one decision on the topic, with a real rider."""
    from app.services.dispatch_service import get_service

    _seed_order("ord-1")
    _seed_rider("rider-1")

    service = get_service()
    await service.handle_event(_ready_payload("ord-1"))

    decisions = _decisions(aws["queue_url"])
    assert len(decisions) == 1
    decision = decisions[0]["decision"]
    assert decision["order_id"] == "ord-1"
    assert decision["mode"] == "single"
    assert decision["broadcast"] is False
    assert decision["assigned_rider_id"] == "rider-1"
    assert decision["eta_minutes"] is not None
    assert service.health.orders_dispatched == 1

    # The envelope carries the whole trace, so a decision can be replayed.
    assert decisions[0]["type"] == "dispatch.decision"
    assert [step["node"] for step in decisions[0]["trace"]] == [
        "validate",
        "kitchen.predict",
        "fleet.snapshot",
        "weather.reflex",
        "batching.pair",
        "decide",
        "act",
    ]


async def test_the_decision_carries_the_event_message_attribute(aws, egress) -> None:
    """Consumers filter on the `event` MessageAttribute — it must be there."""
    from app.services.dispatch_service import get_service

    _seed_order("ord-2")
    _seed_rider("rider-1")

    await get_service().handle_event(_ready_payload("ord-2"))

    notifications = _received(aws["queue_url"])
    assert len(notifications) == 1
    assert notifications[0]["MessageAttributes"]["event"]["Value"] == (
        "dispatch.decision"
    )
    assert json.loads(notifications[0]["Message"])["event"] == "dispatch.decision"


async def test_the_weather_reflex_pads_the_eta(aws, egress) -> None:
    """The storm the weather agent sees must show up in the decision."""
    from app.services.dispatch_service import get_service

    _seed_order("ord-3")
    _seed_rider("rider-1")

    await get_service().handle_event(_ready_payload("ord-3"))

    decision = _decisions(aws["queue_url"])[0]["decision"]
    # WMO 95 (storm) = 20 min pad, +5 for the 40 km/h wind.
    assert decision["weather_pad_minutes"] == 25.0


# ─── Idempotency (the at-least-once SQS source) ──────────────────


async def test_a_redelivered_event_is_ignored(aws, egress) -> None:
    """SQS delivers at least once — the claim makes the second run a no-op."""
    from app.services.dispatch_service import get_service

    _seed_order("ord-4")
    _seed_rider("rider-1")

    service = get_service()
    payload = _ready_payload("ord-4")
    await service.handle_event(payload)
    await service.handle_event(payload)

    assert len(_decisions(aws["queue_url"])) == 1
    assert service.health.orders_dispatched == 1
    # The claim itself is persisted, with a TTL for the sweep.
    claim = _claim_row("ord-4")
    assert claim is not None
    assert claim["expiresAt"] > 0


async def test_a_failed_run_releases_the_claim_so_the_retry_reprocesses(
    aws, egress
) -> None:
    """A crash must not burn the order — the claim is released on failure."""
    from app.services.dispatch_service import get_service

    _seed_order("ord-5")
    _seed_rider("rider-1")

    service = get_service()
    real_graph = service._graph

    class _Exploding:
        async def ainvoke(self, state, config=None):
            raise RuntimeError("graph exploded")

    service._graph = _Exploding()
    with pytest.raises(RuntimeError):
        await service.handle_event(_ready_payload("ord-5"))

    # The claim is gone, so the redelivered message is not swallowed.
    assert _claim_row("ord-5") is None

    service._graph = real_graph
    await service.handle_event(_ready_payload("ord-5"))
    assert len(_decisions(aws["queue_url"])) == 1
    assert service.health.orders_dispatched == 1


# ─── The cross-time batching pool ────────────────────────────────


async def test_a_broadcast_order_is_parked_in_the_pool(aws, egress) -> None:
    """Nobody nearby → broadcast → the order waits for a later companion."""
    from app.services.dispatch_service import get_service

    _seed_order("ord-park", drop_lat=12.9800, drop_lng=77.6000)
    # No riders at all → the decision broadcasts.

    service = get_service()
    await service.handle_event(_ready_payload("ord-park"))

    decision = _decisions(aws["queue_url"])[0]["decision"]
    assert decision["broadcast"] is True
    assert decision["dispatch_mode"] == "broadcast"
    assert decision["surge_amount"] > 0
    assert service.health.broadcasts == 1

    rows = _pool_rows("rest-1")
    assert len(rows) == 1
    assert rows[0]["order_id"] == "ord-park"
    # `expiresAt` is the attribute the IaC enables the TTL sweep on.
    assert rows[0]["expiresAt"] > 0

    # And the ops surface reports it.
    snapshot = service.snapshot()
    assert [row["order_id"] for row in snapshot["pending_pool"]] == ["ord-park"]


async def test_a_later_order_pairs_with_the_parked_one(aws, egress) -> None:
    """The pool's whole point: a co-located order batches with the parked one."""
    from app.services.dispatch_service import get_service

    _seed_order("ord-park", drop_lat=12.9800, drop_lng=77.6000)
    await get_service().handle_event(_ready_payload("ord-park"))
    assert len(_pool_rows("rest-1")) == 1

    # A rider comes online, and a second order arrives from the same
    # restaurant — co-located pickup and drop.
    _seed_rider("rider-1")
    _seed_order("ord-pair", drop_lat=12.9802, drop_lng=77.6002)

    service = get_service()
    await service.handle_event(_ready_payload("ord-pair"))

    decisions = _decisions(aws["queue_url"])
    assert len(decisions) == 2
    decision = decisions[1]["decision"]
    assert decision["mode"] == "batch"
    assert decision["broadcast"] is False
    assert decision["batch"]["primary_order_id"] == "ord-pair"
    assert decision["batch"]["secondary_order_id"] == "ord-park"
    assert service.health.batches_formed == 1

    # The companion is consumed — it must not stay in the pool.
    assert _pool_rows("rest-1") == []


async def test_an_unpairable_order_leaves_the_pool_untouched(aws, egress) -> None:
    """A companion too far away is not a companion."""
    from app.services.dispatch_service import get_service

    _seed_order("ord-park", drop_lat=12.9800, drop_lng=77.6000)
    await get_service().handle_event(_ready_payload("ord-park"))

    # ~37 km away: far beyond the batch radius, but with its own rider
    # so the order is ASSIGNED (not broadcast) and stays out of the pool.
    far_lng = 77.5946 + 0.35
    far = {"type": "Point", "coordinates": [far_lng, 12.9716]}
    _seed_rider("rider-1", lat=12.9716, lng=far_lng)
    _seed_order("ord-far", drop_lat=12.9802, drop_lng=77.6002)

    service = get_service()
    await service.handle_event(
        {
            "orderId": "ord-far",
            "restaurantId": "rest-1",
            "location": far,
        }
    )

    decision = _decisions(aws["queue_url"])[1]["decision"]
    assert decision["mode"] == "single"
    assert decision["batch"] is None
    assert decision["broadcast"] is False
    # The parked companion is untouched — it is still waiting for a
    # co-located order.
    assert [row["order_id"] for row in _pool_rows("rest-1")] == ["ord-park"]


# ─── The SQS consumer ────────────────────────────────────────────


def _sqs_event(order_id: str, *, message_id: str = "m-1") -> dict[str, Any]:
    """An SQS record shaped like the SNS → SQS raw delivery the queue gets."""
    body = {
        "event": "order:ready_for_rider",
        "payload": _ready_payload(order_id),
    }
    return {
        "Records": [
            {
                "messageId": message_id,
                "body": json.dumps(body),
                "messageAttributes": {
                    "event": {"stringValue": "order:ready_for_rider"}
                },
            }
        ]
    }


def test_the_consumer_dispatches_a_ready_event(aws, egress) -> None:
    """The Lambda entrypoint runs the graph and reports no failures."""
    from app.handlers import dispatchConsumer

    _seed_order("ord-sqs")
    _seed_rider("rider-1")

    result = dispatchConsumer.handler(_sqs_event("ord-sqs"), None)

    assert result == {"batchItemFailures": []}
    decisions = _decisions(aws["queue_url"])
    assert len(decisions) == 1
    assert decisions[0]["decision"]["assigned_rider_id"] == "rider-1"


def test_the_consumer_redrives_only_the_failed_record(aws, egress) -> None:
    """A bad record is reported for redrive; the good one still lands."""
    from app.handlers import dispatchConsumer

    _seed_order("ord-good")
    _seed_rider("rider-1")

    event = _sqs_event("ord-good", message_id="m-good")
    event["Records"].append(
        {
            "messageId": "m-bad",
            "body": json.dumps(
                {"event": "order:ready_for_rider", "payload": {"orderId": "only-id"}}
            ),
            "messageAttributes": {
                "event": {"stringValue": "order:ready_for_rider"}
            },
        }
    )

    result = dispatchConsumer.handler(event, None)

    assert result == {"batchItemFailures": [{"itemIdentifier": "m-bad"}]}
    decisions = _decisions(aws["queue_url"])
    assert len(decisions) == 1
    assert decisions[0]["decision"]["order_id"] == "ord-good"


def test_the_consumer_ignores_another_services_event(aws, egress) -> None:
    """The queue is shared — only our event type is ours."""
    from app.handlers import dispatchConsumer

    event = {
        "Records": [
            {
                "messageId": "m-other",
                "body": json.dumps({"event": "order:paid", "payload": {"a": 1}}),
                "messageAttributes": {"event": {"stringValue": "order:paid"}},
            }
        ]
    }

    result = dispatchConsumer.handler(event, None)

    assert result == {"batchItemFailures": []}
    assert _decisions(aws["queue_url"]) == []


# ─── The ops HTTP surface ────────────────────────────────────────


def test_the_ops_surface_is_internal_key_protected(aws, egress) -> None:
    """Snapshot and simulate are internal-only — no key, no data."""
    from fastapi.testclient import TestClient

    from app.core.config import get_settings
    from app.main import app

    settings = get_settings()
    with TestClient(app) as client:
        assert client.get("/api/dispatch/snapshot").status_code == 403
        assert (
            client.get(
                "/api/dispatch/snapshot",
                headers={"x-internal-key": settings.internal_service_key},
            ).status_code
            == 200
        )


def test_the_simulate_endpoint_runs_the_graph(aws, egress) -> None:
    """The staging tool drives the same path the consumer does."""
    from fastapi.testclient import TestClient

    from app.core.config import get_settings
    from app.main import app

    _seed_order("ord-sim")
    _seed_rider("rider-1")

    settings = get_settings()
    with TestClient(app) as client:
        resp = client.post(
            "/api/dispatch/simulate",
            headers={"x-internal-key": settings.internal_service_key},
            json=_ready_payload("ord-sim"),
        )
        assert resp.status_code == 200
        assert resp.json()["success"] is True

    decisions = _decisions(aws["queue_url"])
    assert len(decisions) == 1
    assert decisions[0]["decision"]["assigned_rider_id"] == "rider-1"
