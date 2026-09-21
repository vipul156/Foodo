import { getChannel } from "./rabbitmq.js";

// ─── Verification event publisher (fanout) ──────────────────
// Same pattern as the realtime publisher: publish-and-forget onto a
// fanout exchange. The request path never waits on consumers, and any
// new consumer (fraud scoring, seller scorecards, push notifications)
// binds its own queue without the publisher changing.
//
// Message shape: { type, data }
//   type: "verification.packing" | "verification.delivery"
//   data: the full verification result (see controllers/verification.ts)

export const publishVerificationEvent = (
  type: "verification.packing" | "verification.delivery",
  data: unknown,
) => {
  const channel = getChannel();

  if (!channel) {
    // Events are best-effort analytics — never block or fail the
    // verification request because the broker is down.
    console.error(`Verification publish failed (${type}): RabbitMQ not connected`);
    return;
  }

  channel.publish(
    process.env.VERIFICATION_EXCHANGE || "verification.events",
    "",
    Buffer.from(JSON.stringify({ type, data })),
    { persistent: true },
  );
};
