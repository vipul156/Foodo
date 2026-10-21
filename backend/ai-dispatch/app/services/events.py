"""Dispatch event wiring — SNS replaces the RabbitMQ dispatch.events fanout.

Decision envelopes (mode, rider, ETA, batching trace) are published onto
the platform's domain-event topic with the ``event`` MessageAttribute so
consumers (analytics, dashboards, future routers) bind their own queue
with a FilterPolicy — exactly like the TS tier's fanout publishers.

Publishing is analytics-grade: fire-and-forget. A dropped event costs
one missing dashboard tick, never a lost dispatch (the saga continues on
the rider side; the decision itself is the trace of record).
"""

from __future__ import annotations

from typing import Any

from pycommon.aws import publish_domain_event


def publish_decision(envelope: dict[str, Any]) -> None:
    """Fanout one dispatch decision — never raises, never blocks."""
    publish_domain_event("dispatch.decision", envelope)
