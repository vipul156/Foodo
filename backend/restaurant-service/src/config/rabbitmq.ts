import { createAmqpManager } from "@foodo/backend-common/queue";

// ─── RabbitMQ wiring (restaurant-service) ───────────────────
// Connection lifecycle lives in the shared createAmqpManager factory
// (resilient reconnect, backoff+jitter, heartbeat, channel-ready hooks).
// This file only declares THIS service's topology:
//   - PAYMENT_QUEUE  — gateway payment-success events (utils publishes)
//   - ORDER_QUEUE    — order-flow events (order:ready_for_rider)
//   - fanout exchange — domain events + realtime broadcasts
// Consumers attach via onChannelReady in their consumer modules.
const manager = createAmqpManager({
  queues: ["PAYMENT_QUEUE", "ORDER_QUEUE"],
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
