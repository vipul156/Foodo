import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
} from "@aws-sdk/client-sqs";
import { getIo } from "../socket.js";

// ─── Event source: SNS → SQS poller (realtime-service) ──────
// This service STAYS long-running — Socket.IO needs a persistent server.
// Only its event source changes: instead of consuming the RabbitMQ
// fanout exchange, it long-polls the REALTIME_QUEUE (an SQS queue
// subscribed to the SNS events topic, no filter — it broadcasts every
// event it receives, exactly like the old fanout consumer).
//
// Every other service now publishes to SNS instead of the exchange; the
// wire envelope is unchanged: { event, room, payload }.
//
// Failure semantics preserved from the RabbitMQ consumer: emit failures
// are best-effort UI updates — logged and acked (removed), never
// retried (retrying a socket emit would just requeue-loop).

const queueUrl = () => process.env.REALTIME_QUEUE_URL ?? "";
const sqs = new SQSClient({ maxAttempts: 3 });

const WAIT_TIME_SEC = 20; // long poll — near-real-time, far fewer empty pulls
const VISIBILITY_SEC = 60; // emit has this long before the message redelivers

let running = false;

const unwrapSnsEnvelope = (body: string): {
  event: string;
  room?: string;
  payload: any;
} | null => {
  try {
    const parsed = JSON.parse(body);
    // SNS subscription wraps the publisher's message: { TopicArn, Message }
    return parsed.TopicArn ? JSON.parse(parsed.Message) : parsed;
  } catch {
    return null;
  }
};

const pollOnce = async (): Promise<void> => {
  const out = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl(),
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: WAIT_TIME_SEC,
      MessageAttributeNames: ["All"],
    }),
  );

  for (const message of out.Messages ?? []) {
    const envelope = message.Body
      ? unwrapSnsEnvelope(message.Body)
      : null;

    if (envelope?.event && envelope.room) {
      // One broadcast per message. Emit failures are swallowed so the
      // message is still removed (same ack policy as the RMQ consumer).
      try {
        getIo().to(envelope.room).emit(envelope.event, envelope.payload ?? {});
      } catch (err) {
        console.error("Socket emit failed:", err);
      }
    }

    // Unknown/malformed messages are dropped quietly — the shared fanout
    // carried every service's events, not all were ours.
    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl(),
        ReceiptHandle: message.ReceiptHandle!,
      }),
    ).catch((err) =>
      console.error("SQS delete failed (will redeliver):", err?.message),
    );
  }
};

/**
 * Start the background poll loop. Never throws and never blocks boot —
 * identical contract to the old connectRealtimeEvents(). A dropped loop
 * (visibility timeout exhausted twice) restarts itself after a pause.
 */
export const connectRealtimeEvents = (): void => {
  if (running) return;
  running = true;

  void (async () => {
    while (running) {
      try {
        await pollOnce();
      } catch (error) {
        console.error(
          "SQS poll failed — retrying:",
          error instanceof Error ? error.message : error,
        );
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  })();

  console.log(
    `Realtime consuming events from SQS queue (SNS topic fan-in) — long-poll ${WAIT_TIME_SEC}s`,
  );
};
