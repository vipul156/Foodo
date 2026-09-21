import amqp from "amqplib";
import { consumeClaimEvents } from "./claim.consumer.js";

// ─── RabbitMQ (resilient, consumer-reattaching) ─────────────
// Same pattern as the rider service: background connect with backoff,
// topology re-asserted on every fresh channel, consumers re-attach via
// onChannelReady.

type AMQPConnection = Awaited<ReturnType<typeof amqp.connect>>;

let connection: AMQPConnection | undefined;
let channel: amqp.Channel | undefined;
let running = false;
let attempts = 0;

const readyCallbacks: Array<(ch: amqp.Channel) => void | Promise<void>> = [];

const CONNECT_BASE_DELAY_MS = 500;
const CONNECT_MAX_DELAY_MS = 30_000;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const backoffDelay = () => {
  const exponential = Math.min(
    CONNECT_MAX_DELAY_MS,
    CONNECT_BASE_DELAY_MS * 2 ** attempts,
  );
  return Math.round(exponential / 2 + Math.random() * (exponential / 2));
};

const notifyReady = async (fresh: amqp.Channel): Promise<void> => {
  for (const callback of readyCallbacks) {
    try {
      await callback(fresh);
    } catch (error) {
      console.error("RabbitMQ channel-ready callback failed:", error);
    }
  }
};

const attemptConnect = async (): Promise<boolean> => {
  try {
    const conn = await amqp.connect(process.env.RABBITMQ_URL!);
    const ch = await conn.createChannel();

    conn.on("error", (err) => console.error("RabbitMQ connection error:", err.message));
    ch.on("error", (err) => console.error("RabbitMQ channel error:", err.message));

    conn.on("close", () => {
      if (connection !== conn) return;
      connection = undefined;
      if (channel === ch) channel = undefined;
      console.error("RabbitMQ connection closed — reconnecting in background");
      void connectLoop();
    });
    ch.on("close", () => {
      if (channel === ch) channel = undefined;
    });

    // Topology: the agent publishes state transitions here (fanout —
    // realtime/analytics consumers bind their own queues)
    await ch.assertExchange(
      process.env.AGENT_EXCHANGE || "agent.events",
      "fanout",
      { durable: true },
    );

    connection = conn;
    channel = ch;
    attempts = 0;
    console.log("Connected to RabbitMQ");
    await notifyReady(ch);
    return true;
  } catch (error) {
    console.error(
      `RabbitMQ not available (attempt ${attempts}) — will retry:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
};

const connectLoop = async (): Promise<void> => {
  if (running || connection) return;
  running = true;
  try {
    while (!connection) {
      attempts++;
      if (await attemptConnect()) break;
      await delay(backoffDelay());
    }
  } finally {
    running = false;
  }
};

export const connectRabbitMQ = (): void => {
  void connectLoop();
};

export const getChannel = (): amqp.Channel | undefined => channel;

export const onChannelReady = (
  callback: (ch: amqp.Channel) => void | Promise<void>,
): void => {
  readyCallbacks.push(callback);
  if (channel) void callback(channel);
};

export { consumeClaimEvents };
