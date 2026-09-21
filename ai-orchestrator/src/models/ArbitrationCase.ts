import { Schema, Document, model } from "mongoose";

// ─── Arbitration case — the agent's audit record ─────────────
// Every dispute that reaches the agent produces one of these, whatever
// the outcome (auto-refunded, escalated, rejected). Support tooling and
// fraud reviewers consume this as the single source of truth for "what
// did the agent know and why did it act".

export interface IAgentStep {
  tool: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  at: Date;
  durationMs: number;
  tokens?: {
    prompt: number;
    completion: number;
  };
}

export interface IArbitrationCase extends Document {
  caseId: string;
  orderId: string;
  customerId: string;
  complaint: string;
  channel: "chat" | "email" | "app";
  photoUrl: string | null;

  status: "running" | "auto_refunded" | "voucher_issued" | "escalated" | "rejected" | "failed";
  decision: string | null;
  decisionReason: string | null;
  refundAmount: number | null;
  voucherCode: string | null;

  damageSeverity: "none" | "minor" | "major" | "destroyed" | "unclear" | null;
  trustScore: number | null;
  telemetryFlags: string[];

  steps: IAgentStep[];
  escalatedTo: string | null;
  escalatedAt: Date | null;

  startedAt: Date;
  finishedAt: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const arbitrationCaseSchema = new Schema<IArbitrationCase>(
  {
    caseId: { type: String, required: true, unique: true },
    orderId: { type: String, required: true, index: true },
    customerId: { type: String, required: true, index: true },
    complaint: { type: String, required: true },
    channel: { type: String, enum: ["chat", "email", "app"], default: "app" },
    photoUrl: { type: String, default: null },

    status: {
      type: String,
      enum: ["running", "auto_refunded", "voucher_issued", "escalated", "rejected", "failed"],
      default: "running",
      index: true,
    },
    decision: { type: String, default: null },
    decisionReason: { type: String, default: null },
    refundAmount: { type: Number, default: null },
    voucherCode: { type: String, default: null },

    damageSeverity: {
      type: String,
      enum: ["none", "minor", "major", "destroyed", "unclear", null],
      default: null,
    },
    trustScore: { type: Number, default: null },
    telemetryFlags: { type: [String], default: [] },

    steps: { type: Schema.Types.Mixed, default: [] },
    escalatedTo: { type: String, default: null },
    escalatedAt: { type: Date, default: null },

    startedAt: { type: Date, required: true },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Admin review queue: escalated cases awaiting a human
arbitrationCaseSchema.index({ status: 1, createdAt: -1 });
// Customer dispute-rate lookups feed the trust score
arbitrationCaseSchema.index({ customerId: 1, createdAt: -1 });

export const ArbitrationCase = model<IArbitrationCase>(
  "ArbitrationCase",
  arbitrationCaseSchema,
);
