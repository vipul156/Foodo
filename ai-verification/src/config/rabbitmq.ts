import amqp from "amqplib";

// ─── RabbitMQ connection (resilient) ────────────────────────
// Same contract as the other services: connect in the background with
// retries, never gate the HTTP server on the broker. Verification
// events are analytics — the service degrades gracefully without MQ.

let channel: amqp.Channel | undefined;
let running = false;
let attempts = 0;

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

const attemptConnect = async (): Promise<boolean> => {
  try {
    const connection = await amqp.connect(process.env.RABBITMQ_URL!);
    const ch = await connection.createChannel();

    connection.on("error", (err) =>
      console.error("RabbitMQ connection error:", err.message),
    );
    ch.on("error", (err) => console.error("RabbitMQ channel error:", err.message));

    connection.on("close", () => {
      channel = undefined;
      console.error("RabbitMQ connection closed — reconnecting in background");
      void connectLoop();
    });
    ch.on("close", () => {
      channel = undefined;
    });

    // Fanout exchange — fraud/analytics consumers bind their own queues
    await ch.assertExchange(
      process.env.VERIFICATION_EXCHANGE || "verification.events",
      "fanout",
      { durable: true },
    );

    channel = ch;
    attempts = 0;
    console.log("Connected to RabbitMQ");
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
  if (running || channel) return;
  running = true;
  try {
    while (!channel) {
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
