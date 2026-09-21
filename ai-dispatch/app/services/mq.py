"""RabbitMQ layer (aio-pika) — consume order events, publish dispatch events.

Topology (all durable, idempotent asserts on every connect):
  - order.events   (fanout) → dispatch.orders queue (this service consumes;
    the restaurant service's order.publisher fanouts `order:ready_for_rider`
    here IN ADDITION to the legacy point-to-point ORDER_QUEUE so the rider
    service's existing consumer is untouched)
  - dispatch.events (fanout) → decisions, ETA broadcasts, surge signals for
    analytics / dashboards / future consumers

Consumer resilience mirrors the Node queue.resilience pattern:
at-least-once with retry parking-lot (TTL dead-letter back to the main
queue) and a DLQ for poison pills after 3 attempts. Handlers must be
idempotent.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any, Awaitable, Callable

import aio_pika
from aio_pika import DeliveryMode, ExchangeType

from app.core.config import get_settings
from app.core.logging import get_logger

log = get_logger(__name__)
settings = get_settings()

MAX_RETRIES = 3
RETRY_BASE_DELAY_MS = 2000

Handler = Callable[[dict[str, Any]], Awaitable[None]]


class MessageBus:
    def __init__(self) -> None:
        self._connection: aio_pika.abc.AbstractRobustConnection | None = None
        self._channel: aio_pika.abc.AbstractRobustChannel | None = None
        self._handlers: list[Handler] = []
        self._consumer_tag: str | None = None

    def on_order_event(self, handler: Handler) -> None:
        self._handlers.append(handler)

    async def start(self) -> None:
        """Connect and start consuming. RobustConnection auto-reconnects;
        topology is re-asserted on every reconnect by aio-pika itself."""
        self._connection = await aio_pika.connect_robust(
            settings.rabbitmq_url,
            heartbeat=30,
            reconnect_interval=5,
            fail_fast=False,
        )
        self._channel = await self._connection.channel()
        await self._channel.set_qos(prefetch_count=10)

        self._order_exchange = await self._channel.declare_exchange(
            settings.order_exchange, ExchangeType.FANOUT, durable=True
        )
        self._dispatch_exchange = await self._channel.declare_exchange(
            settings.dispatch_exchange, ExchangeType.FANOUT, durable=True
        )

        queue = await self._channel.declare_queue(settings.dispatch_queue, durable=True)
        await queue.bind(self._order_exchange)

        # Retry parking lot + DLQ (same pattern as the Node services)
        self._retry_queue = await self._channel.declare_queue(
            f"{settings.dispatch_queue}.retry",
            durable=True,
            arguments={
                "x-dead-letter-exchange": "",
                "x-dead-letter-routing-key": settings.dispatch_queue,
            },
        )
        self._dlq = await self._channel.declare_queue(
            f"{settings.dispatch_queue}.dlq", durable=True
        )

        await queue.consume(self._on_message)
        log.info(
            "dispatch consumer attached (queue=%s exchange=%s)",
            settings.dispatch_queue,
            settings.order_exchange,
        )

    async def _on_message(self, message: aio_pika.abc.AbstractIncomingMessage) -> None:
        async with message.process(ignore_processed=True):
            try:
                event = json.loads(message.body)
            except Exception as exc:  # noqa: BLE001 — malformed JSON is a poison pill
                log.error("[DLQ] malformed event JSON: %s", exc)
                await self._to_dlq(message, f"malformed json: {exc}")
                return

            for handler in self._handlers:
                try:
                    await handler(event)
                except Exception as exc:  # noqa: BLE001
                    headers = dict(message.headers or {})
                    retries = int(headers.get("x-retry-count", 0))
                    error = str(exc)[:500]
                    if retries < MAX_RETRIES:
                        delay = RETRY_BASE_DELAY_MS * (2**retries)
                        await self._retry_queue.publish(
                            message.body,
                            delivery_mode=DeliveryMode.PERSISTENT,
                            headers={**headers, "x-retry-count": retries + 1, "x-last-error": error},
                            expiration=delay,
                        )
                        log.warning(
                            "[RETRY] attempt %s/%s in %sms — %s",
                            retries + 1,
                            MAX_RETRIES,
                            delay,
                            error,
                        )
                    else:
                        await self._to_dlq(message, error)
                    return

    async def _to_dlq(self, message: aio_pika.abc.AbstractIncomingMessage, error: str) -> None:
        await self._dlq.publish(
            message.body,
            delivery_mode=DeliveryMode.PERSISTENT,
            headers={
                **dict(message.headers or {}),
                "x-last-error": error,
                "x-failed-at": str(time.time()),
            },
        )
        log.error("[ALERT][DLQ] parked — MANUAL INSPECTION REQUIRED — %s", error)

    async def publish_decision(self, envelope: dict[str, Any]) -> None:
        """Fanout a dispatch decision — best-effort, never blocks dispatch."""
        try:
            await self._dispatch_exchange.publish(
                aio_pika.Message(
                    body=json.dumps(envelope, default=str).encode(),
                    delivery_mode=DeliveryMode.PERSISTENT,
                    content_type="application/json",
                ),
                routing_key="",
            )
        except Exception as exc:  # noqa: BLE001 — analytics-grade only
            log.warning("dispatch publish failed: %s", exc)

    async def close(self) -> None:
        if self._connection:
            await self._connection.close()
