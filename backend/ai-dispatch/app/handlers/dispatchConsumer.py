"""Lambda entrypoint — the sole runtime of the dispatch graph.

Intake arrives on a DIRECT SNS subscription to the foodo-events topic,
filtered on ``order:ready_for_rider`` (push, so there is no queue to
poll while the platform is idle). ``handle_push_batch`` unwraps the SNS
envelope back to the {event, payload} body the TS publisher emits, and
re-raises a failed delivery so SNS retries it and the subscription's
redrive policy parks the poison message in the DLQ.
"""

import asyncio

from pycommon.aws import attr_to_string, handle_push_batch

from app.services.dispatch_service import get_service


def _on_record(payload, attributes: dict) -> None:
    event_name = attr_to_string(attributes, "event")
    if event_name and event_name != "order:ready_for_rider":
        return  # defensive — the subscription filter is the primary guard

    # The notification body is the publisher envelope: {event, payload}
    inner = payload.get("payload") if isinstance(payload, dict) and "event" in payload else payload

    service = get_service()
    # The graph is async; the Lambda handler entrypoint is sync — one
    # event-loop run per record keeps every handler idempotent and
    # simple (no loop juggling across warm containers).
    asyncio.run(service.handle_event(inner))


def handler(event: dict, context) -> dict:
    return handle_push_batch(event, _on_record)
