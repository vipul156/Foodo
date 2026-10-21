"""Commerce event wiring — SNS replaces the RabbitMQ commerce.events fanout.

Every turn completion (and other analytics-grade moments) is published
onto the platform's domain-event topic with the ``event`` MessageAttribute
so downstream consumers bind their own queues with FilterPolicies — the
same posture as the TS tier's publishers.

Publishing is fire-and-forget: these events are observability/notification
grade, never on the money path — a dropped publish must not break a turn.
"""

from __future__ import annotations

from typing import Any

from pycommon.aws import publish_domain_event


def publish_commerce_event(event_type: str, payload: dict[str, Any]) -> None:
    """Never raises — analytics-grade fanout only."""
    publish_domain_event(f"commerce.{event_type}", payload)
