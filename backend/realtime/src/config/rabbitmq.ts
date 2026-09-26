import amqp from "amqplib";
import { getIo } from "../socket.js";

let channel: amqp.Channel | undefined;

// ─── Realtime event consumer (fanout) ───────────────────────
// This service OWNS the fanout exchange: producers (order service) publish
// and forget — they never call realtime over HTTP, so a realtime outage or
// restart can never degrade the order API. The fanout shape also means any
// other consumer (analytics, push notifications) can bind its own queue to
// the same exchange without the publisher changing at all.
export const connectRealtimeEvents = async () => {
  try {
    const exchange = process.env.REALTIME_EXCHANGE || "order.status_changed";
    const queue = process.env.REALTIME_QUEUE || "realtime.emit";

    const connection = await amqp.connect(process.env.RABBITMQ_URL!);
    channel = await connection.createChannel();

    await channel.assertExchange(exchange, "fanout", { durable: true });
    await channel.assertQueue(queue, { durable: true });
    await channel.bindQueue(queue, exchange, "");

    channel.consume(queue, (msg) => {
      if (!msg) return;

      try {
        const { event, room, payload } = JSON.parse(msg.content.toString());

        if (event && room) {
          // Same semantics the HTTP /emit endpoint had — one broadcast per
          // message. Emit failures are best-effort UI updates, so the
          // message is always acked (no requeue loops).
          getIo().to(room).emit(event, payload ?? {});
        }
      } catch (err) {
        // Malformed/poison message — drop it rather than requeue-looping
        console.error("Dropped malformed realtime event:", err);
      }

      channel?.ack(msg);
    });

    console.log(`Realtime consuming events from exchange "${exchange}"`);
  } catch (error) {
    console.error("Error connecting to RabbitMQ:", error);
  }
};
