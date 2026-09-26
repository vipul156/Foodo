import { makeDomainEventPublisher } from "@foodo/backend-common/queue";
import { getChannelAsync, manager } from "./rabbitmq.js";

// ─── Rider domain event publisher (fanout) ──────────────────
// The accept hot path never waits on the restaurant or realtime
// SERVICES — but it MUST know the event reached the BROKER. If the
// publish fails (broker down), the caller rolls the rider claim back;
// a fire-and-forget drop here would strand the rider offline forever
// with no order and no compensation. Built on the shared bounded-wait
// domain-event publisher.
// Wire shape matches the realtime envelope: { event, room, payload }.
export const publishRiderEvent = makeDomainEventPublisher(manager);

// Order-flow events travel to the ORDER_QUEUE work queue ({ type, data }
// envelope) — kept for the few callers that use the queue directly.
export const publishEvent = async (type: string, data: unknown) => {
    const channel = await getChannelAsync();
    channel.sendToQueue(
        process.env.ORDER_QUEUE!,
        Buffer.from(JSON.stringify({ type, data })),
        { persistent: true },
    );
};
