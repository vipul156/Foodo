"""RabbitMQ publisher — commerce.events (fanout) for downstream consumers.

Fire-and-forget with a background connection thread; publishing failures
are logged and swallowed — events here are analytics/notification-grade,
never on the money path. Same posture as the Node services' publishers.
"""

from __future__ import annotations

import json
import threading
from typing import Any

import pika

from app.core.config import get_settings
from app.core.logging import get_logger

log = get_logger(__name__)
settings = get_settings()

_conn: pika.BlockingConnection | None = None
_channel: pika.adapters.blocking_connection.BlockingChannel | None = None
_lock = threading.Lock()


def _ensure_channel():
    global _conn, _channel
    if _conn is not None and _conn.is_open and _channel is not None and _channel.is_open:
        return _channel
    with _lock:
        if _conn is not None and not _conn.is_open:
            _conn = None
            _channel = None
        if _channel is None or not _channel.is_open:
            params = pika.URLParameters(settings.rabbitmq_url)
            _conn = pika.BlockingConnection(params)
            _channel = _conn.channel()
            _channel.exchange_declare(
                exchange=settings.commerce_exchange, exchange_type="fanout", durable=True
            )
            log.info("commerce.events exchange ready")
    return _channel


def publish_commerce_event(event_type: str, payload: dict[str, Any]) -> None:
    """Never raises — analytics-grade fanout only."""
    body = {"type": event_type, "payload": payload, "at": _now_ms()}
    try:
        channel = _ensure_channel()
        channel.basic_publish(
            exchange=settings.commerce_exchange,
            routing_key="",
            body=json.dumps(body, default=str),
            properties=pika.BasicProperties(
                content_type="application/json", delivery_mode=2
            ),
        )
    except Exception as exc:  # noqa: BLE001 — publish must never break the API
        log.warning("commerce event publish failed (%s): %s", event_type, exc)


def _now_ms() -> int:
    import time

    return int(time.time() * 1000)


def close() -> None:
    global _conn, _channel
    try:
        if _conn is not None and _conn.is_open:
            _conn.close()
    except Exception:  # noqa: BLE001
        pass
    _conn = None
    _channel = None
