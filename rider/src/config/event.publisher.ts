import { getChannel, getChannelAsync } from "./rabbitmq.js";

// ─── Rider domain event publisher (fanout) ──────────────────
// Published onto the order-events fanout exchange. The accept hot path
// never waits on the restaurant or realtime SERVICES — but it MUST know
// the event reached the BROKER. If the publish fails (broker down), the
// caller rolls the rider claim back; a fire-and-forget drop here would
// strand the rider offline forever with no order and no compensation.
// Each interested service (restaurant assignment, realtime sockets)
// consumes via its own queue bound to the exchange.
// Wire shape matches the realtime envelope: { event, room, payload }.
export const publishRiderEvent = async (
  event: string,
  payload: unknown,
  room?: string,
  timeoutMs = 5000,
): Promise<boolean> => {
  let channel;
  try {
    // Bounded wait rides out an in-flight reconnect instead of failing
    // the accept for a transient broker blip.
    channel = await getChannelAsync(timeoutMs);
  } catch {
    console.error(`Rider publish failed (${event}): RabbitMQ not connected`);
    return false;
  }

  try {
    return channel.publish(
      process.env.REALTIME_EXCHANGE || "order.status_changed",
      "",
      Buffer.from(JSON.stringify({ event, room, payload })),
      { persistent: true },
    );
  } catch (error) {
    console.error(
      `Rider publish failed (${event}):`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
};
