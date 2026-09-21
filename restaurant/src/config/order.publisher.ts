import { getChannelAsync } from "./rabbitmq.js";

export const publishEvent = async (type: string, data: any) => {
    // Order-flow events must not be silently dropped during a short
    // RabbitMQ blip — wait briefly for a live channel. A persistent
    // outage surfaces as a rejection (5xx) the client can retry, instead
    // of a silent fire-and-forget loss.
    const channel = await getChannelAsync();
    const body = Buffer.from(JSON.stringify({ type, data }));

    channel.sendToQueue(
        process.env.ORDER_QUEUE!,
        body,
        { persistent: true }
    );

    // ─── Fanout mirror for the ai-dispatch swarm ──────────────
    // ORDER_QUEUE is point-to-point: whoever consumes first wins, and
    // the rider service already owns it. The dispatch swarm binds its
    // OWN queue to this fanout exchange so it receives every
    // order:ready_for_rider independently. Publish is best-effort: a
    // missing exchange (broker blip) must not fail the order hot path.
    try {
        const exchange = process.env.ORDER_EVENTS_EXCHANGE || "order.events";
        channel.publish(exchange, "", body, { persistent: true });
    } catch (err) {
        console.error(
            "order.events fanout publish failed (non-fatal):",
            err instanceof Error ? err.message : err,
        );
    }
};
