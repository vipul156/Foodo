import { makeDomainEventPublisher } from "@foodo/backend-common/queue";
import { manager, getChannelAsync } from "./rabbitmq.js";

export const publishEvent = async (type: string, data: any) => {
    // Order-flow events must not be silently dropped during a short
    // RabbitMQ blip — wait briefly for a live channel. A persistent
    // outage surfaces as a rejection (5xx) the client can retry, instead
    // of a silent fire-and-forget loss. Payload rides as { type, data }
    // — the work-queue envelope the rider-service consumer expects.
    const channel = await getChannelAsync();
    channel.sendToQueue(
        process.env.ORDER_QUEUE!,
        Buffer.from(JSON.stringify({ type, data })),
        { persistent: true },
    );
};

// ─── Domain events onto the fanout exchange ─────────────────
// Cross-service commands/notifications (payment intent stamps, rider
// status transitions, cancellation releases) travel as events on the
// shared fanout exchange. Bounded wait rides out a reconnect blip; a
// hard broker outage resolves false so callers can decide (log / 5xx /
// compensate). Built on the shared domain-event publisher.
export const publishOrderEvent = makeDomainEventPublisher(manager);
