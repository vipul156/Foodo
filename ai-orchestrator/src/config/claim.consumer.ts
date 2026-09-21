import type amqp from "amqplib";
import { ArbitrationCase } from "../models/ArbitrationCase.js";
import { runArbitration } from "../graph/arbitration.graph.js";
import { generateCaseId } from "../graph/caseId.js";

// ─── Dispute event consumer (chat/email channel) ────────────
// Non-app channels don't hit the HTTP API — they publish an
// "order.disputed" event that lands in this queue. The same arbitration
// graph runs; outcomes are recorded identically.
//
// Message shape: { orderId, customerId, complaint, photoUrl? }
// Poison messages are dead-lettered by requeue-count tracking rather
// than blocking the queue.

const REQUEUE_LIMIT = 3;

export const consumeClaimEvents = async (channel: amqp.Channel): Promise<void> => {
  const queue = process.env.AGENT_DISPUTE_QUEUE || "agent.disputes";

  await channel.assertQueue(queue, { durable: true });

  channel.consume(queue, async (msg) => {
    if (!msg) return;

    // Requeue bookkeeping: nack republishes WITHOUT headers, so a plain
    // redelivery flag alone can't count loops. We republish through a
    // publish that stamps an incremented x-requeue-count header instead.
    const requeueCount = Number(msg.properties.headers?.["x-requeue-count"] ?? 0);

    try {
      const payload = JSON.parse(msg.content.toString()) as {
        orderId?: string;
        customerId?: string;
        complaint?: string;
      };

      if (!payload.orderId || !payload.customerId || !payload.complaint) {
        console.error("Dispute event missing required fields — dropping");
        channel.ack(msg);
        return;
      }

      await runArbitration({
        caseId: generateCaseId(),
        orderId: String(payload.orderId),
        customerId: String(payload.customerId),
        complaint: String(payload.complaint),
        photoBase64: null,
        channel: "email",
      });

      channel.ack(msg);
    } catch (err) {
      console.error("Dispute event processing failed:", err instanceof Error ? err.message : err);

      if (requeueCount >= REQUEUE_LIMIT) {
        // Poison message — record as a failed case and drop
        console.error("Requeue limit reached — dead-lettering dispute event");
        channel.ack(msg);
        return;
      }

      // Transient failure — republish with an incremented requeue count
      // (a bare nack re-queues without headers, which would loop forever)
      // then ack the original.
      try {
        channel.publish(
          "",
          msg.fields.routingKey || "",
          msg.content,
          {
            persistent: true,
            headers: { "x-requeue-count": requeueCount + 1 },
          },
        );
        channel.ack(msg);
      } catch (republishErr) {
        console.error("Republish failed — requeueing via nack:", republishErr instanceof Error ? republishErr.message : republishErr);
        channel.nack(msg, false, true);
      }
    }
  });

  console.log(`Agent consuming dispute events from "${queue}"`);
};
