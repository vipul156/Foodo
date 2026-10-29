"""Shared AWS primitives for Foodo serverless services.

Python analog of ``@foodo/backend-common/aws``:

  SNS topic (EVENTS_TOPIC_ARN)   — fanout + domain event publishers
  SQS queues                     — work-queue send + batch Lambda handler
  DynamoDB                       — per-process reused clients, env-resolved
                                   table names (IaC injects them per stack)

Client reuse mirrors the TS layer: one client per warm container, created
lazily and never per-request (the #1 Lambda startup killers are per-call
client construction and Cold boto3 resource creation).
"""

from __future__ import annotations

import json
import os
import threading
from decimal import Decimal
from typing import Any, Callable

import boto3
from botocore.config import Config

# Timeouts below the Lambda envelope budget: clients must fail fast, never
# hang the handler until the runtime kills the invocation.
_BOTO_CONFIG = Config(
    retries={"max_attempts": 3, "mode": "adaptive"},
    connect_timeout=3,
    read_timeout=15,
    region_name=os.environ.get("AWS_REGION") or None,
)

_lock = threading.Lock()
_resource = None
_sns = None
_sqs = None


def _get_resource():
    global _resource
    if _resource is None:
        with _lock:
            if _resource is None:
                kwargs: dict[str, Any] = {"config": _BOTO_CONFIG}
                endpoint = os.environ.get("AWS_DYNAMO_ENDPOINT")
                if endpoint:  # local development (dynamodb-local / moto)
                    kwargs["endpoint_url"] = endpoint
                _resource = boto3.resource("dynamodb", **kwargs)
    return _resource


def _get_sns():
    global _sns
    if _sns is None:
        with _lock:
            if _sns is None:
                _sns = boto3.client("sns", config=_BOTO_CONFIG)
    return _sns


def _get_sqs():
    global _sqs
    if _sqs is None:
        with _lock:
            if _sqs is None:
                _sqs = boto3.client("sqs", config=_BOTO_CONFIG)
    return _sqs


# ─── Tables ──────────────────────────────────────────────────


def table(env_var: str, fallback: str):
    """Resolve a table from env (IaC injects per-stack names) and return a
    reused Table resource. Falls back to the platform default name so
    local development works without IaC exports."""
    name = os.environ.get(env_var) or fallback
    return _get_resource().Table(name)


def to_dynamo(value: Any) -> Any:
    """Make a Python structure safe for the boto3 DynamoDB serializer.

    DynamoDB has no float type: the resource serializer REJECTS ``float``
    outright ("Float types are not supported. Use Decimal types instead."),
    and it rejects the WHOLE item — one float nested three levels deep
    fails a write whose sibling keys are all fine.

    Python floats are everywhere in this codebase (prices, coordinates,
    ratios), so every write that can carry one must go through here.

    Floats become ``Decimal(repr(value))`` — ``repr`` is the shortest
    round-trippable form, so ``12.98`` stays ``12.98`` instead of
    becoming ``12.980000000000000426``. ``Decimal``, ``int``, ``str``,
    ``bool`` and ``None`` pass through untouched; dicts and lists are
    walked recursively.
    """
    if isinstance(value, float):
        return Decimal(repr(value))
    if isinstance(value, dict):
        return {key: to_dynamo(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_dynamo(item) for item in value]
    return value


def from_dynamo(value: Any) -> Any:
    """Convert a DynamoDB item back into plain Python numbers.

    The mirror of :func:`to_dynamo`. DynamoDB has no float type, so every
    number comes back as ``Decimal`` — and pydantic serializes a
    ``Decimal`` as a JSON STRING, which would hand the UI ``"249.5"``
    where it expects ``249.5``.

    Integral values come back as ``int`` (a DynamoDB ``N`` of ``2`` is
    ``Decimal('2')``); fractional ones as ``float``.
    """
    if isinstance(value, Decimal):
        return int(value) if value.as_tuple().exponent >= 0 else float(value)
    if isinstance(value, dict):
        return {key: from_dynamo(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [from_dynamo(item) for item in value]
    return value


# ─── Events (SNS) ────────────────────────────────────────────


def _topic_arn() -> str:
    return os.environ.get("EVENTS_TOPIC_ARN", "")


def publish_domain_event(event: str, payload: Any, *, raise_on_error: bool = False) -> bool:
    """Publish a domain event onto the platform's topic with the same wire
    envelope the TS services use: body {event, payload}, MessageAttribute
    ``event`` for consumer FilterPolicies.

    raise_on_error=False (analytics/observability grade): log + swallow.
    raise_on_error=True (money- or rider-affecting): surface to the caller
    so the flow can compensate (SQS redrive instead of a dropped event).
    """
    try:
        arn = _topic_arn()
        if not arn:
            raise RuntimeError("EVENTS_TOPIC_ARN is not configured")
        body = {"event": event, "room": None, "payload": payload}
        _get_sns().publish(
            TopicArn=arn,
            Message=json.dumps(body, default=str),
            MessageAttributes={
                "event": {"DataType": "String", "StringValue": event[:256]},
            },
        )
        return True
    except Exception as exc:  # noqa: BLE001
        if raise_on_error:
            raise
        print(f"[pycommon] event publish failed ({event}): {exc}")
        return False


def publish_realtime_event(event: str, room: str, payload: Any) -> bool:
    """Fanout a realtime broadcast ({event, room, payload}) — same wire
    shape the realtime service consumes to emit socket rooms."""
    try:
        arn = _topic_arn()
        if not arn:
            raise RuntimeError("EVENTS_TOPIC_ARN is not configured")
        _get_sns().publish(
            TopicArn=arn,
            Message=json.dumps(
                {"event": event, "room": room, "payload": payload}, default=str
            ),
            MessageAttributes={
                "event": {"DataType": "String", "StringValue": event[:256]},
            },
        )
        return True
    except Exception as exc:  # noqa: BLE001 — dropped broadcast costs one stale UI
        print(f"[pycommon] realtime publish failed ({event} → {room}): {exc}")
        return False


# ─── Work queues (SQS) ───────────────────────────────────────


def send_work_item(queue_url: str, work_type: str, data: Any) -> None:
    """Send a {type, data} work item; `type` rides both as a MessageAttribute
    (consumers filter without deserializing) and in the body (payload-only
    consumers). Raises — the caller surfaces a retryable failure."""
    _get_sqs().send_message(
        QueueUrl=queue_url,
        MessageBody=json.dumps({"type": work_type, "data": data}, default=str),
        MessageAttributes={
            "type": {"DataType": "String", "StringValue": work_type[:256]},
        },
    )


def _unwrap_record(record: dict[str, Any]) -> tuple[Any, dict[str, Any]]:
    """Extract (payload, attributes) supporting three wire shapes:
      - our work envelope {type, data}
      - SNS RAW delivery (message attributes preserved, body is the inner JSON)
      - SNS wrapped delivery (body.TopicArn + body.Message JSON string)
    """
    body = record.get("body", "")
    try:
        parsed = json.loads(body)
    except Exception:
        return None, {}

    if isinstance(parsed, dict) and "TopicArn" in parsed and "Message" in parsed:
        try:
            parsed = json.loads(parsed["Message"])
        except Exception:
            return None, {}
    if isinstance(parsed, dict) and "data" in parsed and "type" in parsed:
        return parsed["data"], record.get("messageAttributes", {}) or {}
    return parsed, record.get("messageAttributes", {}) or {}


def attr_to_string(message_attributes: dict[str, Any], name: str) -> str | None:
    attr = message_attributes.get(name) or {}
    value = attr.get("stringValue")
    return value.get("Value") if isinstance(value, dict) else value


def handle_sqs_batch(
    event: dict[str, Any],
    handler: Callable[[Any, dict[str, Any]], Any],
) -> dict[str, Any]:
    """Batch Lambda entrypoint with partial-failure redrive (the SQS analog
    of the TS handleSqsBatch): failed record ids land in batchItemFailures
    so only those are retried; DLQ is owned by the queue's redrive policy.

    Handlers must stay idempotent — SQS is at-least-once.
    """
    failures: list[str] = []
    records = (event or {}).get("Records") or []

    for record in records:
        message_id = record.get("messageId") or "?"
        try:
            payload, attributes = _unwrap_record(record)
            handler(payload, attributes)
        except Exception as exc:  # noqa: BLE001 — report, don't raise past the batch
            print(f"[pycommon][SQS] message {message_id} failed: {exc}")
            failures.append(str(message_id))

    return {"batchItemFailures": [{"itemIdentifier": f} for f in failures]}


# ─── Push trigger (SNS → Lambda) ─────────────────────────────


def to_sqs_shape(event: dict[str, Any]) -> dict[str, Any]:
    """Normalise an SNS notification batch into the SQS record shape.

    A direct SNS subscription delivers ``{Records: [{Sns}]}``. Raw message
    delivery is impossible for Lambda endpoints, so the inner
    ``Sns.Message`` is unwrapped here — handlers then see exactly the
    bytes a raw-delivery SQS subscription used to carry. SQS events pass
    through untouched, which keeps one handler usable on both triggers.
    """
    records = (event or {}).get("Records") or []
    if not records or "Sns" not in records[0]:
        return event

    return {
        "Records": [
            {
                "messageId": record["Sns"].get("MessageId"),
                "body": record["Sns"].get("Message", ""),
                "messageAttributes": {
                    name: {"stringValue": value.get("Value")}
                    for name, value in (record["Sns"].get("MessageAttributes") or {}).items()
                },
            }
            for record in records
        ]
    }


def is_sns_event(event: dict[str, Any]) -> bool:
    """True when the Lambda was invoked by an SNS subscription rather than
    an SQS event source mapping."""
    records = (event or {}).get("Records") or []
    return bool(records) and "Sns" in records[0]


def handle_push_batch(
    event: dict[str, Any],
    handler: Callable[[Any, dict[str, Any]], Any],
) -> dict[str, Any]:
    """Entrypoint for a function subscribed DIRECTLY to the event topic.

    SNS ignores ``batchItemFailures`` — it retries on a RAISED error — so a
    partial failure from :func:`handle_sqs_batch` is re-raised here. Without
    the raise the failed record would be acked and lost; with it, SNS
    retries the delivery and the subscription's ``RedrivePolicy`` parks the
    poison message in the queue's DLQ.

    Handlers must stay idempotent — SNS is at-least-once, exactly like SQS.
    """
    result = handle_sqs_batch(to_sqs_shape(event), handler)

    if is_sns_event(event) and result["batchItemFailures"]:
        failed = ", ".join(f["itemIdentifier"] for f in result["batchItemFailures"])
        raise RuntimeError(f"push delivery failed for record(s): {failed}")

    return result
