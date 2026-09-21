import { internalPost, internalGet, getInternalHeaders } from "../config/http.js";
import { ArbitrationCase } from "../models/ArbitrationCase.js";

// ─── Tools: autonomous actions + HITL fallback ───────────────
// The ONLY two money-touching actions the agent can take, both bounded:
//   - executeRefund → utils' capped, idempotent endpoint (server-side
//     amount caps the agent cannot bypass)
//   - issueVoucher → capped voucher codes for goodwill gestures
// Everything else lands in the admin review queue (HITL).

export interface RefundOutcome {
  ok: boolean;
  providerRefundId: string | null;
  amount: number | null;
  error: string | null;
}

export const executeRefund = async (
  caseDoc: { caseId: string; orderId: string; customerId: string },
  amount: number,
  reason: string,
): Promise<RefundOutcome> => {
  try {
    // Pre-flight claim: clamp the requested amount to what the order can
    // actually refund (total minus refunds already granted). The agent
    // proposes "up to AGENT_MAX_AUTO_REFUND" — utils remains the hard
    // enforcer, but clamping here avoids spurious CAP_EXCEEDED blocks
    // when the policy amount exceeds a small order total.
    let clamped = amount;
    try {
      const claim = await internalGet<{
        order?: {
          totalAmount?: number;
          refunds?: { amount: number }[];
        };
      }>(
        `${process.env.UTILS_SERVICE_URL}/api/utils/refund/order/${caseDoc.orderId}/claim`,
        { headers: getInternalHeaders() },
      );
      const total = Number(claim?.order?.totalAmount ?? 0);
      const already = (claim?.order?.refunds ?? []).reduce(
        (sum, r) => sum + Number(r.amount || 0),
        0,
      );
      if (total > 0) {
        clamped = Math.min(amount, Math.max(0, total - already));
      }
    } catch {
      // Claim unavailable — send the policy amount and let utils enforce
      // its caps (worst case: CAP_EXCEEDED → escalation path).
    }

    if (clamped <= 0) {
      return { ok: false, providerRefundId: null, amount: 0, error: "Nothing left to refund on this order" };
    }

    const data = await internalPost<{
      success?: boolean;
      providerRefundId?: string | null;
      amount?: number;
      message?: string;
      code?: string;
    }>(
      `${process.env.UTILS_SERVICE_URL}/api/utils/refund/execute`,
      {
        orderId: caseDoc.orderId,
        amount: clamped,
        reason: `[${caseDoc.caseId}] ${reason}`.slice(0, 200),
        initiatedBy: "agent:refund-arbiter:v1",
      },
      { headers: getInternalHeaders() },
    );

    return {
      ok: Boolean(data?.success),
      providerRefundId: data?.providerRefundId ?? null,
      amount: data?.amount ?? null,
      error: data?.success ? null : data?.message ?? "Refund rejected",
    };
  } catch (err: any) {
    return {
      ok: false,
      providerRefundId: null,
      amount: null,
      error: err?.response?.data?.message ?? err?.message ?? "Refund endpoint unreachable",
    };
  }
};

// ─── Voucher (goodwill) ──────────────────────────────────────
// Fixed cap keeps a manipulated LLM from minting arbitrary value.

export const VOUCHER_CAP = Number(process.env.AGENT_VOUCHER_CAP) || 150;

export interface VoucherOutcome {
  ok: boolean;
  code: string | null;
  amount: number | null;
  error: string | null;
}

export const issueVoucher = async (
  caseDoc: { caseId: string; customerId: string },
  amount: number,
  reason: string,
): Promise<VoucherOutcome> => {
  const capped = Math.min(Math.max(0, Math.round(amount)), VOUCHER_CAP);

  // Vouchers are recorded, not yet wired to checkout credits — the code
  // format is reserved (FOODO-AGENT-) and review tooling can revoke.
  const code = `FOODO-AGENT-${caseDoc.caseId.slice(-8).toUpperCase()}`;

  try {
    await internalPost(
      `${process.env.RESTAURANT_SERVICE_URL}/api/internal/vouchers`,
      {
        code,
        customerId: caseDoc.customerId,
        amount: capped,
        reason: `[${caseDoc.caseId}] ${reason}`.slice(0, 200),
        issuedBy: "agent:refund-arbiter:v1",
      },
      { headers: getInternalHeaders() },
    );
    return { ok: true, code, amount: capped, error: null };
  } catch (err: any) {
    // Voucher service hiccup doesn't undo a refund decision — the case
    // record still carries the intent, review tooling can re-issue.
    return {
      ok: false,
      code: null,
      amount: capped,
      error: err?.response?.data?.message ?? "Voucher endpoint unreachable",
    };
  }
};

// ─── HITL fallback: admin review queue ───────────────────────
// Ambiguous or suspicious cases are summarized and parked for a human.
// The LLM writes the summary; the case document carries the evidence.

export interface EscalationSummary {
  summary: string;
  recommendation: string;
}

export const escalateToHuman = async (
  caseDoc: {
    caseId: string;
    orderId: string;
    complaint: string;
    damageSeverity: string | null;
    trustScore: number | null;
    telemetryFlags: string[];
  },
  summaryInput: {
    evidenceSummary: string;
    recommendation: string;
  },
): Promise<{ ok: boolean; summary: string }> => {
  const summary = [
    `Case ${caseDoc.caseId} escalated for human review.`,
    `Complaint: ${caseDoc.complaint.slice(0, 200)}`,
    `Vision triage: ${caseDoc.damageSeverity ?? "unknown"}`,
    `Trust score: ${caseDoc.trustScore ?? "n/a"}`,
    caseDoc.telemetryFlags.length
      ? `Telemetry flags: ${caseDoc.telemetryFlags.join(", ")}`
      : "Telemetry: no flags",
    `Agent analysis: ${summaryInput.evidenceSummary.slice(0, 400)}`,
    `Agent recommendation: ${summaryInput.recommendation.slice(0, 200)}`,
  ].join("\n");

  try {
    await internalPost(
      `${process.env.ADMIN_SERVICE_URL}/api/admin/review-queue`,
      {
        caseId: caseDoc.caseId,
        orderId: caseDoc.orderId,
        type: "refund_arbitration",
        summary,
        priority: caseDoc.telemetryFlags.includes("LONG_DETOUR") ? "high" : "normal",
      },
      { headers: getInternalHeaders() },
    );
    return { ok: true, summary };
  } catch (err: any) {
    // The case stays status="escalated" in our own store with the full
    // evidence — the admin queue is a convenience, not the only record.
    console.error(
      "Admin queue unreachable (case remains escalated locally):",
      err?.response?.data?.message ?? err?.message,
    );
    return { ok: false, summary };
  }
};
