import { createAmqpManager } from "@foodo/backend-common/queue";

// ─── RabbitMQ wiring (rider-service) ────────────────────────
// Connection lifecycle lives in the shared createAmqpManager factory
// (resilient reconnect, backoff+jitter, heartbeat, channel-ready hooks).
// This file only declares THIS service's topology:
//   - RIDER_QUEUE    — order:ready_for_rider events (restaurant publishes)
//   - ORDER_QUEUE    — same work queue, consumed by the order-ready matcher
//   - fanout exchange — domain events + realtime broadcasts
// Consumers attach via onChannelReady in their consumer modules.
const manager = createAmqpManager({
  queues: ["RIDER_QUEUE", "ORDER_QUEUE"],
  exchangeEnvVar: "REALTIME_EXCHANGE",
  defaultExchange: "order.status_changed",
});

export const {
  connectRabbitMQ,
  getChannel,
  getChannelAsync,
  onChannelReady,
  exchangeName,
} = manager;
export { manager };
