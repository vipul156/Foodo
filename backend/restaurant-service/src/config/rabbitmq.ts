import amqp from "amqplib";

// ─── Resilient RabbitMQ connection manager ──────────────────
// The HTTP server must never be gated on RabbitMQ: connection runs in
// the background with exponential backoff + jitter, a dropped connection
// (broker restart, VM reboot) triggers an automatic reconnect that
// re-asserts topology, and every consumer re-attaches to the fresh
// channel via onChannelReady. Publishers can wait a bounded time for a
// live channel (getChannelAsync) instead of failing outright.

type AMQPConnection = Awaited<ReturnType<typeof amqp.connect>>;

let connection: AMQPConnection | undefined;
let channel: amqp.Channel | undefined;

let running = false;
let attempts = 0;

// Resolved when a live channel appears — used by getChannelAsync.
const readyWaiters: Array<() => void> = [];
// Setup hooks re-run on EVERY fresh channel: consume registrations die
// with the channel, so consumers must re-attach after each reconnect.
const readyCallbacks: Array<(channel: amqp.Channel) => void | Promise<void>> =
  [];

const CONNECT_BASE_DELAY_MS = 500;
const CONNECT_MAX_DELAY_MS = 30_000;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Exponential backoff with jitter, capped — the jitter keeps concurrent
// replicas from reconnecting in a synchronized thundering herd.
const backoffDelay = () => {
  const exponential = Math.min(
    CONNECT_MAX_DELAY_MS,
    CONNECT_BASE_DELAY_MS * 2 ** attempts,
  );
  return Math.round(exponential / 2 + Math.random() * (exponential / 2));
};

const notifyReady = async (fresh: amqp.Channel): Promise<void> => {
  for (const waiter of readyWaiters.splice(0)) waiter();

  for (const callback of readyCallbacks) {
    try {
      await callback(fresh);
    } catch (error) {
      console.error("RabbitMQ channel-ready callback failed:", error);
    }
  }
};

// Heartbeat (as a URL query param — amqplib 2.x connect() socket options
// no longer take it) keeps a half-open TCP connection (VM reboot, SG
// change) from looking healthy — dead peers surface as a 'close' event.
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

    // Without an 'error' listener an emitted error would crash the
    // process (EventEmitter semantics).
    conn.on("error", (err) =>
      console.error("RabbitMQ connection error:", err.message),
    );
    ch.on("error", (err) =>
      console.error("RabbitMQ channel error:", err.message),
    );

    conn.on("close", () => {
      // Stale event from a replaced connection — the live one owns reconnect.
      if (connection !== conn) return;
      connection = undefined;
      if (channel === ch) channel = undefined;
      console.error("RabbitMQ connection closed — reconnecting in background");
      void connectLoop();
    });
    ch.on("close", () => {
      if (channel === ch) channel = undefined;
    });

    // Topology — idempotent, re-asserted on every reconnect.
    // Realtime events fanout exchange — this service publishes and
    // forgets; the realtime service owns the queue side.
    await ch.assertExchange(
      process.env.REALTIME_EXCHANGE || "order.status_changed",
      "fanout",
      { durable: true },
    );
    await ch.assertQueue(process.env.PAYMENT_QUEUE!, { durable: true });
    await ch.assertQueue(process.env.ORDER_QUEUE!, { durable: true });

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

// Fire-and-forget: starts (or joins) the background connect/retry loop.
// Never throws and never blocks — boot and the HTTP API are independent
// of RabbitMQ availability.
export const connectRabbitMQ = (): void => {
  void connectLoop();
};

// Synchronous snapshot; undefined while disconnected. Best-effort
// publishers use this and drop their event when it's missing.
export const getChannel = (): amqp.Channel | undefined => channel;

// Bounded wait for a live channel — for publishes that must not be
// silently dropped during a brief outage or in-flight reconnect.
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

// Register setup to run on every fresh channel: at initial connect AND
// after each reconnect. Re-entrancy is safe — one call per channel.
export const onChannelReady = (
  callback: (channel: amqp.Channel) => void | Promise<void>,
): void => {
  readyCallbacks.push(callback);
  if (channel) void callback(channel);
};