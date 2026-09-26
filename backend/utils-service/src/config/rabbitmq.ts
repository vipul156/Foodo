import { createAmqpManager } from "@foodo/backend-common/queue";

// ─── RabbitMQ wiring (utils-service) ────────────────────────
// Connection lifecycle lives in the shared createAmqpManager factory
// (resilient reconnect, backoff+jitter, heartbeat). Utils only
// publishes — no consumers — so this topology is:
//   - PAYMENT_QUEUE   — payment-success work queue (restaurant consumes)
//   - fanout exchange — domain events (payment.intent.created)
const manager = createAmqpManager({
  queues: ["PAYMENT_QUEUE"],
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
