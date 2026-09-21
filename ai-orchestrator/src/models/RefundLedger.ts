import { Schema, Document, model } from "mongoose";

// ─── Refund ledger — platform-level dispute accounting ──────
// One doc per customer: cumulative refund totals + dispute counts.
// Feeds the trust score (dispute rate) and gives fraud tooling a
// single-query view of a customer's refund history. The payment
// provider remains the source of truth for actual money movement;
// this ledger is the agent's bounded memory.

export interface IRefundLedger extends Document {
  customerId: string;
  totalRefunded: number;
  refundCount: number;
  disputeCount: number;
  escalatedCount: number;
  lastRefundAt: Date | null;
  updatedAt?: Date;
  createdAt?: Date;
}

const refundLedgerSchema = new Schema<IRefundLedger>(
  {
    customerId: { type: String, required: true, unique: true },
    totalRefunded: { type: Number, default: 0 },
    refundCount: { type: Number, default: 0 },
    disputeCount: { type: Number, default: 0 },
    escalatedCount: { type: Number, default: 0 },
    lastRefundAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const RefundLedger = model<IRefundLedger>("RefundLedger", refundLedgerSchema);
