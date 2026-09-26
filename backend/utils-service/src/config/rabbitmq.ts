import amqp from "amqplib";

// ─── Resilient RabbitMQ connection manager (utils-service) ──
// Same shape as the restaurant/rider managers: the HTTP server must
// never be gated on RabbitMQ — connection runs in the background with
// exponential backoff + jitter, a dropped connection triggers an
// automatic reconnect, and publishers can wait a bounded time for a
// live channel instead of crashing on an undefined one.

type AMQPConnection = Awaited<ReturnType<typeof amqp.connect>>;

let connection: AMQPConnection | undefined;
let channel: amqp.Channel | undefined;

let running = false;
let attempts = 0;

const readyWaiters: Array<() => void> = [];

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

// Heartbeat as URL param (amqplib 2.x) — half-open TCP connections
// surface as 'close' events instead of looking healthy.
const connectUrl = (): string => {
  const raw = process.env.RABBITMQ_URL!;
  try {
    const url = new URL(raw);
    url.searchParams.set("heartbeat", "30");
    return url.toString();
  } catch {
    return raw;
  }
};

const attemptConnect = async (): Promise<boolean> => {
  try {
    const conn = await amqp.connect(connectUrl());
    const ch = await conn.createChannel();

    conn.on("error", (err) =>
      console.error("RabbitMQ connection error:", err.message),
    );
    ch.on("error", (err) =>
      console.error("RabbitMQ channel error:", err.message),
    );

    conn.on("close", () => {
      if (connection !== conn) return; // stale event from a replaced conn
      connection = undefined;
      if (channel === ch) channel = undefined;
      console.error("RabbitMQ connection closed — reconnecting in background");
      void connectLoop();
    });
    ch.on("close", () => {
      if (channel === ch) channel = undefined;
    });

    // Topology — idempotent, re-asserted on every reconnect.
    await ch.assertQueue(process.env.PAYMENT_QUEUE!, { durable: true });
    // Fanout exchange for domain events (payment.intent.created);
    // realtime + the order owner each bind their own queue.
    await ch.assertExchange(
      process.env.REALTIME_EXCHANGE || "order.status_changed",
      "fanout",
      { durable: true },
    );

    connection = conn;
    channel = ch;
    attempts = 0;

    console.log("Connected to RabbitMQ");
    for (const waiter of readyWaiters.splice(0)) waiter();
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

// Fire-and-forget: starts (or joins) the background connect/retry loop.
export const connectRabbitMQ = (): void => {
  void connectLoop();
};

// Bounded wait for a live channel — publishers must not silently drop
// during a brief outage or in-flight reconnect.
export const getChannelAsync = (timeoutMs = 5000): Promise<amqp.Channel> => {
  if (channel) return Promise.resolve(channel);

  return new Promise((resolve, reject) => {
    const waiter = () => {
      clearTimeout(timer);
      if (channel) resolve(channel);
      else reject(new Error("RabbitMQ channel lost while waiting"));
    };

    const timer = setTimeout(() => {
      const index = readyWaiters.indexOf(waiter);
      if (index !== -1) readyWaiters.splice(index, 1);
      reject(
        new Error(`RabbitMQ channel not available within ${timeoutMs}ms`),
      );
    }, timeoutMs);

    readyWaiters.push(waiter);
  });
};
