import { getChannel } from "./rabbitmq.js";

// ─── Agent event publisher (fanout) ──────────────────────────
// State transitions (case started, node executed, decision, finished)
// are published here. The realtime service can bind a queue and push
// live "thought graph" updates to admin dashboards over Socket.IO;
// analytics can bind their own queue for cost/latency tracking.
// Publish-and-forget: observability never blocks the agent.

export type AgentEventType =
  | "agent.case_started"
  | "agent.step"
  | "agent.decision"
  | "agent.case_finished"
  | "agent.case_failed";

export const publishAgentEvent = (type: AgentEventType, data: unknown) => {
  const channel = getChannel();
  if (!channel) {
    console.error(`Agent publish failed (${type}): RabbitMQ not connected`);
    return;
  }
  channel.publish(
    process.env.AGENT_EXCHANGE || "agent.events",
    "",
    Buffer.from(
      JSON.stringify({ type, data, at: new Date().toISOString() }),
    ),
    { persistent: true },
  );
};
