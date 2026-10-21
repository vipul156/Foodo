import { makeDomainEventPublisher, sendWorkItem } from "@foodo/backend-common/aws";
import type { DisputeWorkItem } from "../types.js";

// ─── Agent event wiring (SNS + SQS) ──────────────────────────
// Replaces the old RabbitMQ fanout exchange + work queue:
//
//   agent.events (fanout) → SNS topic (foodo-events)
//   agent.disputes (queue) → SQS work queue (agent-disputes)
//
// Agent state transitions (case started, node executed, decision,
// finished) are published onto the platform's domain-event topic.
// Consumers (realtime dashboards, cost/latency aggregation) bind
// their own queue with a filter policy on the event name.
//
// Publishing is fire-and-forget: observability never blocks the
// arbitration path, and a dropped event costs one missing dashboard
// tick — never a lost case (the case row is the source of truth).

export type AgentEventType =
  | "agent.case_started"
  | "agent.step"
  | "agent.decision"
  | "agent.case_finished"
  | "agent.case_failed";

const publishAgentDomainEvent = makeDomainEventPublisher();

export const publishAgentEvent = async (
  type: AgentEventType,
  data: unknown,
): Promise<void> => {
  await publishAgentDomainEvent(type, {
    ...(data as object),
    at: new Date().toISOString(),
  });
};

// ─── Dispute intake from non-app channels ─────────────────────
// Chat/email complaints do not come through the HTTP API: the
// channel that owns them publishes a work item onto the disputes
// queue, and this service's consumer runs the same arbitration
// graph the HTTP path uses.
//
// The photo NEVER rides the queue: SQS caps a message at 256 KB and
// a phone photo base64-encodes to megabytes. The producer uploads
// the bytes to Cloudinary first and puts the resulting URL here; the
// consumer downloads it again for the vision call.
export const publishDisputeWorkItem = async (
  item: DisputeWorkItem,
): Promise<void> => {
  const queueUrl = process.env.AGENT_DISPUTES_QUEUE_URL;
  if (!queueUrl) {
    throw new Error("AGENT_DISPUTES_QUEUE_URL is not configured");
  }
  await sendWorkItem(queueUrl, "DISPUTE", item);
};
