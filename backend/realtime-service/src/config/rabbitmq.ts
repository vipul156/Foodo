import {
  createAmqpManager,
  startFanoutConsumer,
  type EventHandler,
} from "@foodo/backend-common/queue";
import { getIo } from "../socket.js";

// ─── RabbitMQ wiring (realtime-service) ─────────────────────
// Connection lifecycle lives in the shared createAmqpManager factory.
// This service owns the fanout exchange: producers (order service, rider
// service, utils) publish and forget — they never call realtime over
// HTTP, so a realtime outage or restart can never degrade the order API.
// The fanout shape also means any other consumer (analytics, push
// notifications) can bind its own queue to the same exchange without the
// publisher changing at all.
//
// Migrated from a one-shot connect (a broker restart previously killed
// socket broadcasts until the whole service restarted) to the shared
// resilient manager: auto-reconnect + consumer re-attachment.
const manager = createAmqpManager({
  exchangeEnvVar: "REALTIME_EXCHANGE",
  defaultExchange: "order.status_changed",
});

export const connectRealtimeEvents = () => {
  manager.connectRabbitMQ();

  startFanoutConsumer(manager, {
    queueEnvVar: "REALTIME_QUEUE",
    defaultQueue: "realtime.emit",
    handlers: {
      // catch-all is used instead — realtime emits every event it receives
    },
    onUnhandled: (({
      event,
      room,
      payload,
    }) => {
      if (event && room) {
        // One broadcast per message. Emit failures are best-effort UI
        // updates — swallowed here so the shared builder always acks
        // (retrying a socket emit would just requeue-loop).
        try {
          getIo().to(room).emit(event, payload ?? {});
        } catch (err) {
          console.error("Socket emit failed:", err);
        }
      }
    }) as EventHandler,
  });

  console.log(
    `Realtime consuming events from exchange "${manager.exchangeName()}"`,
  );
};
