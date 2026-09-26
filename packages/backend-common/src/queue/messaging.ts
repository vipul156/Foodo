import type { Channel, ConsumeMessage } from "amqplib";
import type { AmqpManager } from "./amqp-manager.js";
import {
  declareResilienceQueues,
  handleConsumeFailure,
  type EventHandler,
} from "./resilience.js";

// ─── Shared publisher + consumer builders ────────────────────
// Every service's publisher/consumer files follow the same shape; these
// builders own the repetitive parts (channel acquisition, JSON envelope,
// ack/DLQ policy) so services only provide their business logic.
//
// Envelope contract on the fanout exchange: { event, room?, payload }.
// Realtime consumes { event + room } broadcasts; service consumers
// dispatch on `event` and ignore messages without one of their own.

// ─── Publishers ──────────────────────────────────────────────

/**
 * Fire-and-forget fanout publisher (UI-tier style). Drops the event with
 * a log when the broker is disconnected — never blocks or fails the
 * request. Best for realtime broadcasts.
 */
export function makeFanoutPublisher(manager: AmqpManager) {
  return (event: string, room: string, payload: unknown): void => {
    const channel = manager.getChannel();

    if (!channel) {
      console.error(
        `Realtime publish failed (${event}): RabbitMQ not connected`,
      );
      return;
    }

    channel.publish(
      manager.exchangeName(),
      "",
      Buffer.from(JSON.stringify({ event, room, payload })),
      { persistent: true },
    );
  };
}

/**
 * Bounded-wait fanout publisher (domain-event style). Waits up to
 * timeoutMs for a live channel; a hard broker outage resolves false so
 * callers can decide — reject the request, roll back a claim, or log.
 * Best for events whose loss requires compensation.
 */
export function makeDomainEventPublisher(manager: AmqpManager) {
  return async (
    event: string,
    payload: unknown,
    timeoutMs = 5000,
  ): Promise<boolean> => {
    let channel;
    try {
      channel = await manager.getChannelAsync(timeoutMs);
    } catch {
      console.error(
        `Event publish failed (${event}): RabbitMQ not connected`,
      );
      return false;
    }

    try {
      return channel.publish(
        manager.exchangeName(),
        "",
        Buffer.from(JSON.stringify({ event, room: undefined, payload })),
        { persistent: true },
      );
    } catch (error) {
      console.error(
        `Event publish failed (${event}):`,
        error instanceof Error ? error.message : error,
      );
      return false;
    }
  };
}

/**
 * Work-queue publisher onto a named queue (sendToQueue). Waits briefly
 * for a live channel; a persistent outage throws so the HTTP layer
 * surfaces a 5xx the client can retry, instead of a silent drop.
 */
export function makeQueuePublisher(manager: AmqpManager) {
  return async (
    queueEnvVar: string,
    defaultQueue: string,
    type: string,
    data: unknown,
  ): Promise<void> => {
    const channel = await manager.getChannelAsync();
    channel.sendToQueue(
      process.env[queueEnvVar] || defaultQueue,
      Buffer.from(JSON.stringify({ type, data })),
      { persistent: true },
    );
  };
}

// ─── Consumers ───────────────────────────────────────────────

/**
 * Attach a fanout-event consumer to a durable queue bound to the
 * manager's exchange. handlers dispatch on the envelope's `event` key;
 * unhandled events are acked and dropped (multiple services share the
 * exchange — not every event is ours). Failures flow through the shared
 * retry+DLQ policy. Re-attach is automatic on every reconnect because
 * the registration runs inside onChannelReady.
 */
export function startFanoutConsumer(
  manager: AmqpManager,
  opts: {
    queueEnvVar: string;
    defaultQueue: string;
    handlers: Record<string, EventHandler>;
    /** Optional catch-all for events not in `handlers` (e.g. logging). */
    onUnhandled?: EventHandler;
  },
) {
  const { handlers, onUnhandled } = opts;

  const onMessage =
    (channel: Channel, queue: string) =>
    async (msg: ConsumeMessage | null): Promise<void> => {
      if (!msg) return;

      try {
        const { event, room, payload } = JSON.parse(msg.content.toString());

        const handler = handlers[event];
        if (handler) {
          await handler({ event, room, payload, msg });
          channel.ack(msg);
          return;
        }

        if (onUnhandled) {
          await onUnhandled({ event, room, payload, msg });
        }
        // Unknown event on the shared fanout — not ours, drop quietly.
        channel.ack(msg);
      } catch (error) {
        // DB blips retry with backoff, then DLQ + alert
        handleConsumeFailure(channel, msg, queue, error);
        return;
      }
    };

  manager.onChannelReady(async (channel) => {
    const exchange = manager.exchangeName();
    const queue = process.env[opts.queueEnvVar] || opts.defaultQueue;

    await channel.assertExchange(exchange, "fanout", { durable: true });
    await channel.assertQueue(queue, { durable: true });
    await channel.bindQueue(queue, exchange, "");
    await declareResilienceQueues(channel, queue);

    channel.consume(queue, onMessage(channel, queue));

    console.log(`Consuming fanout events from exchange "${exchange}" [${queue}]`);
  });
}

/**
 * Attach a typed work-queue consumer ({ type, data } envelope) with the
 * shared retry+DLQ policy. Registration re-runs on every fresh channel.
 */
export function startQueueConsumer(
  manager: AmqpManager,
  opts: {
    queueEnvVar: string;
    defaultQueue: string;
    onMessage: (data: any, msg: ConsumeMessage) => Promise<void> | void;
  },
) {
  const consume =
    (channel: Channel, queue: string) =>
    async (msg: ConsumeMessage | null): Promise<void> => {
      if (!msg) return;

      try {
        const event = JSON.parse(msg.content.toString());
        if (event?.type) {
          await opts.onMessage(event.data, msg);
        }
        channel.ack(msg);
      } catch (error) {
        handleConsumeFailure(channel, msg, queue, error);
        return;
      }
    };

  manager.onChannelReady(async (channel) => {
    const queue = process.env[opts.queueEnvVar] || opts.defaultQueue;

    await declareResilienceQueues(channel, queue);
    channel.consume(queue, consume(channel, queue));

    console.log(`Consuming queue "${queue}"`);
  });
}
