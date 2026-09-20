import { getChannel } from "./rabbitmq.js";

// ─── Rider domain event publisher (fanout) ──────────────────
// Publish-and-forget onto the order-events fanout exchange. The accept
// hot path never waits on the restaurant or realtime services: it claims
// the rider locally, drops the event, and returns 200. Each interested
// service (restaurant assignment, realtime sockets) consumes via its own
// queue bound to the exchange.
// Wire shape matches the realtime envelope: { event, room, payload }.
export const publishRiderEvent = (
  event: string,
  payload: unknown,
  room?: string,
) => {
  const channel = getChannel();

  if (!channel) {
    // RabbitMQ not connected — log and move on; the rider claim already
    // succeeded locally and the order flow continues elsewhere.
    console.error(`Rider publish failed (${event}): RabbitMQ not connected`);
    return;
  }

  channel.publish(
    process.env.REALTIME_EXCHANGE || "order.status_changed",
    "",
    Buffer.from(JSON.stringify({ event, room, payload })),
    { persistent: true },
  );
};
