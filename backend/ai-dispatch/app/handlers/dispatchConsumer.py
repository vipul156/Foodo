"""Lambda SQS entrypoint — the sole runtime of the dispatch graph.

Intake arrives via the service's own dispatch-orders queue, fed by an
SNS subscription filtered on ``order:ready_for_rider`` (raw delivery, so
the message body is the {event, payload} envelope the TS publisher
emits). The queue's redrive policy owns retries; only failed records are
reported back via batchItemFailures.
"""

import asyncio

from pycommon.aws import attr_to_string, handle_sqs_batch

from app.services.dispatch_service import get_service


def _on_record(payload, attributes: dict) -> None:
    event_name = attr_to_string(attributes, "event")
    if event_name and event_name != "order:ready_for_rider":
        return  # defensive — the subscription filter is the primary guard

    # Raw delivery body is the publisher envelope: {event, payload}
    inner = payload.get("payload") if isinstance(payload, dict) and "event" in payload else payload

    service = get_service()
    # The graph is async; the Lambda handler entrypoint is sync — one
    # event-loop run per record keeps every handler idempotent and
    # simple (no loop juggling across warm containers).
    asyncio.run(service.handle_event(inner))


def handler(event: dict, context) -> dict:
    return handle_sqs_batch(event, _on_record)
