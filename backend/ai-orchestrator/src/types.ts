// ─── Arbitration domain types ────────────────────────────────
// Shared by the graph, the tools and the DynamoDB repository.
// The AI tier's domain vocabulary is local to this service — the
// universal @foodo/types package stays free of agent-specific
// shapes so the browser bundle never pulls them in.

export type ArbitrationStatus =
  | "running"
  | "auto_refunded"
  | "voucher_issued"
  | "escalated"
  | "rejected"
  | "failed";

export type ArbitrationChannel = "chat" | "email" | "app";

export type DamageSeverity = "none" | "minor" | "major" | "destroyed" | "unclear";

/** One tool call in the thought graph — the agent's audit trail. */
export interface AgentStep {
  tool: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  /** ISO timestamp. */
  at: string;
  durationMs: number;
  tokens?: {
    prompt: number;
    completion: number;
  };
}

/** The stored arbitration case (one row in the cases table). */
export interface ArbitrationCase {
  caseId: string;
  orderId: string;
  customerId: string;
  complaint: string;
  channel: ArbitrationChannel;
  /** Cloudinary URL of the customer photo — the durable evidence copy. */
  photoUrl: string | null;

  status: ArbitrationStatus;
  decision: string | null;
  decisionReason: string | null;
  refundAmount: number | null;
  voucherCode: string | null;

  damageSeverity: DamageSeverity | null;
  trustScore: number | null;
  telemetryFlags: string[];

  steps: AgentStep[];
  escalatedTo: string | null;
  escalatedAt: string | null;

  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Work item carried by the `agent-disputes` SQS queue.
 *
 * The photo NEVER rides the queue: SQS caps a message at 256 KB and a
 * phone photo base64-encodes to megabytes. The intake Lambda uploads
 * the bytes to Cloudinary and puts the resulting URL here; the
 * consumer downloads it again for the vision call.
 */
export interface DisputeWorkItem {
  caseId: string;
  orderId: string;
  customerId: string;
  complaint: string;
  channel: ArbitrationChannel;
  photoUrl: string | null;
}
