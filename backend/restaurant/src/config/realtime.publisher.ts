import { getChannel } from "./rabbitmq.js";

// ─── Realtime event publisher (fanout) ──────────────────────
// Publish-and-forget onto the fanout exchange the realtime service owns.
// The order hot path never waits on — or even knows about — the socket
// tier: no HTTP call, no timeout, no socket exhaustion, and a realtime
// outage degrades UI updates only, never the order API.
// Message shape matches the old /api/internal/emit contract exactly:
// { event, room, payload }.
export const publishRealtimeEvent = (
  event: string,
  room: string,
  payload: unknown,
) => {
  const channel = getChannel();

  if (!channel) {
    // RabbitMQ not connected — UI refresh is best-effort; log and move on
    // so order requests are never blocked or failed by this.
    console.error(`Realtime publish failed (${event}): RabbitMQ not connected`);
    return;
  }

  channel.publish(
    process.env.REALTIME_EXCHANGE || "order.status_changed",
    "",
    Buffer.from(JSON.stringify({ event, room, payload })),
    { persistent: true },
  );
};
