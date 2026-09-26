import { getChannelAsync } from "./rabbitmq.js";

export const publishEvent = async (type: string, data: any) => {
    // Order-flow events must not be silently dropped during a short
    // RabbitMQ blip — wait briefly for a live channel. A persistent
    // outage surfaces as a rejection (5xx) the client can retry, instead
    // of a silent fire-and-forget loss.
    const channel = await getChannelAsync();
    
    channel.sendToQueue(
        process.env.ORDER_QUEUE!,
        Buffer.from(JSON.stringify({ type, data })),
        { persistent: true }
    );
}

// ─── Domain events onto the fanout exchange ─────────────────
// Cross-service commands/notifications (rider release, order lifecycle)
// travel as events on the same fanout exchange the realtime tier owns.
// Envelope matches the existing consumers: { event, room?, payload } —
// realtime ignores messages without a room, service consumers dispatch
// on `event`. Bounded wait rides out a reconnect blip; a hard broker
// outage rejects so callers can decide (log / 5xx / compensate).
export const publishOrderEvent = async (
    event: string,
    payload: unknown,
    timeoutMs = 5000,
): Promise<boolean> => {
    let channel;
    try {
        channel = await getChannelAsync(timeoutMs);
    } catch {
        console.error(`Order event publish failed (${event}): RabbitMQ not connected`);
        return false;
    }

    try {
        return channel.publish(
            process.env.REALTIME_EXCHANGE || "order.status_changed",
            "",
            Buffer.from(JSON.stringify({ event, room: undefined, payload })),
            { persistent: true },
        );
    } catch (error) {
        console.error(
            `Order event publish failed (${event}):`,
            error instanceof Error ? error.message : error,
        );
        return false;
    }
};
