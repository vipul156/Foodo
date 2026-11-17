"""Domain-event fanout — namespaced, fire-and-forget.

Every service publishes onto the platform's domain-event topic with the
``event`` MessageAttribute so downstream consumers bind their own queues
with FilterPolicies — the same posture as the TS tier's publishers.

Publishing is analytics/notification grade: never on the money path, so a
dropped publish must not break the caller's flow.
"""

from __future__ import annotations

from typing import Any

from pycommon.aws import publish_domain_event


def publish_event(namespace: str, event_type: str, payload: dict[str, Any]) -> None:
    """Publish ``<namespace>.<event_type>`` on the platform domain-event topic.

    Never raises — the underlying publisher swallows (and reports) failures.
    """
    publish_domain_event(f"{namespace}.{event_type}", payload)
