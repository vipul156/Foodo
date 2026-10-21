import {
  appendStep,
  createCase,
  getCase,
  updateCase,
} from "../dynamo/cases.js";
import { incrementLedger } from "../dynamo/ledger.js";
import { triagePhoto, DamageSeverity } from "../tools/triage.js";
import { auditDeliveryTelemetry } from "../tools/telemetry.js";
import { assessTrust, TrustAssessment } from "../tools/trust.js";
import { executeRefund, issueVoucher, escalateToHuman } from "../tools/actions.js";
import { downloadImageBase64 } from "../config/photo.js";
import { callLlm } from "../config/http.js";
import { publishAgentEvent } from "../config/events.js";
import type { ArbitrationChannel, AgentStep, ArbitrationCase } from "../types.js";

// ─── Refund Arbitration Graph ────────────────────────────────
// A bounded-autonomy workflow (LangGraph-style state machine) that
// turns a customer complaint into one of four outcomes:
//
//   auto_refund   — damage verified + trustworthy customer + clean audit
//   voucher       — verified damage but capped/borderline evidence
//   escalate      — HITL: ambiguous, suspicious, or low-trust claims
//   reject        — evidence contradicts the complaint
//
// The LLM classifies (vision triage, escalation summary); a DETERMINISTIC
// policy function decides. Every node appends its tool call + output to
// the case row in DynamoDB, so the full "thought graph" is replayable
// for audits, debugging, and cost attribution.
//
// The case row IS the source of truth: DynamoDB's per-field updates
// mean a node crash leaves the partial trail visible, exactly like the
// old Mongo document — minus the connection state to hold together.

export interface ArbitrationInput {
  caseId: string;
  orderId: string;
  customerId: string;
  complaint: string;
  /**
   * Cloudinary URL of the durable evidence copy. The photo NEVER rides
   * the queue in bytes (SQS caps messages at 256 KB); every intake door
   * (HTTP and chat/email) uploads first, then passes the URL. The graph
   * downloads it again from this location for the vision call.
   */
  photoUrl: string | null;
  channel: ArbitrationChannel;
}

type AgentAction = "auto_refund" | "voucher" | "escalate" | "reject";

const SEVERITY_REFUND: DamageSeverity[] = ["destroyed", "major"];
const MAX_AUTO_REFUND = Number(process.env.AGENT_MAX_AUTO_REFUND) || 500;

const nowIso = () => new Date().toISOString();

/** Timed, audited tool node — every outcome lands in the case row. */
async function track<T>(
  caseId: string,
  tool: string,
  fn: () => Promise<T>,
  toOutput: (result: T) => Record<string, unknown>,
): Promise<T> {
  const start = Date.now();
  const step: AgentStep = {
    tool,
    input: {},
    output: {},
    at: nowIso(),
    durationMs: 0,
  };
  try {
    const result = await fn();
    step.output = toOutput(result);
    step.durationMs = Date.now() - start;
    await appendStep(caseId, step);
    // Observability never blocks the graph: a dropped event costs one
    // missing dashboard tick, never a lost case.
    publishAgentEvent("agent.step", { caseId, tool, durationMs: step.durationMs });
    return result;
  } catch (err) {
    step.output = { error: err instanceof Error ? err.message : String(err) };
    step.durationMs = Date.now() - start;
    await appendStep(caseId, { ...step, tool: `error:${step.tool}` }).catch(() => {});
    throw err;
  }
}

async function recordDecisionStep(
  caseId: string,
  step: AgentStep,
): Promise<void> {
  await appendStep(caseId, step);
}

export const runArbitration = async (input: ArbitrationInput): Promise<ArbitrationCase | null> => {
  const startedAt = nowIso();

  const caseDoc = await createCase({
    caseId: input.caseId,
    orderId: input.orderId,
    customerId: input.customerId,
    complaint: input.complaint.slice(0, 1000),
    channel: input.channel,
    photoUrl: input.photoUrl,
    startedAt,
  });

  publishAgentEvent("agent.case_started", { caseId: caseDoc.caseId, orderId: input.orderId });

  const finish = async (
    status: "auto_refunded" | "voucher_issued" | "escalated" | "rejected" | "failed",
    fields: {
      decision: AgentAction | null;
      reason: string;
      refundAmount?: number | null;
      voucherCode?: string | null;
      escalatedTo?: string | null;
    },
  ): Promise<void> => {
    await updateCase(caseDoc.caseId, {
      status,
      decision: fields.decision,
      decisionReason: fields.reason,
      refundAmount: fields.refundAmount ?? null,
      voucherCode: fields.voucherCode ?? null,
      escalatedTo: fields.escalatedTo ?? null,
      escalatedAt: fields.escalatedTo ? nowIso() : null,
      finishedAt: nowIso(),
    });
    publishAgentEvent("agent.case_finished", {
      caseId: caseDoc.caseId,
      orderId: input.orderId,
      status,
      decision: fields.decision,
    });
  };

  try {
    // ── Node 0: resolve evidence bytes for the vision call ────
    // The durable copy (Cloudinary) is the source; the graph re-downloads
    // it so HTTP/SQS intake produce byte-identical runs.
    const photoBase64 = input.photoUrl ? await downloadImageBase64(input.photoUrl) : null;

    // ── Node 1: vision triage ──────────────────────────────────
    const triage = await track(
      caseDoc.caseId,
      "vision.triage",
      () => triagePhoto(input.complaint, photoBase64),
      (r) => ({
        severity: r.severity,
        category: r.category,
        confidence: r.confidence,
        suspicious: r.suspicious,
      }),
    );

    await updateCase(caseDoc.caseId, { damageSeverity: triage.severity });

    // ── Node 2: delivery telemetry audit ──────────────────────
    const telemetry = await track(
      caseDoc.caseId,
      "telemetry.audit",
      () => auditDeliveryTelemetry(input.orderId),
      (r) => ({
        flags: r.flags,
        detourMinutes: r.detourMinutes,
        handlingScore: r.handlingScore,
      }),
    );

    await updateCase(caseDoc.caseId, { telemetryFlags: telemetry.flags });

    // ── Node 3: customer trust & LTV ──────────────────────────
    const trust = await track(
      caseDoc.caseId,
      "trust.assess",
      () => assessTrust(input.customerId, input.orderId),
      (r) => ({ score: r.score, tier: r.tier, signals: r.signals, refundRate: r.refundRate }),
    );

    await updateCase(caseDoc.caseId, { trustScore: trust.score });

    // ── Node 4: decision (deterministic policy) ───────────────
    const decision = decide(triage, telemetry.flags, trust, photoBase64 !== null);
    await recordDecisionStep(caseDoc.caseId, {
      tool: "decision.evaluate",
      input: {
        severity: triage.severity,
        suspicious: triage.suspicious,
        flags: telemetry.flags,
        trust: trust.score,
      },
      output: { action: decision.action, amount: decision.refundAmount, reason: decision.reason },
      at: nowIso(),
      durationMs: 0,
    });
    publishAgentEvent("agent.decision", {
      caseId: caseDoc.caseId,
      action: decision.action,
      reason: decision.reason,
    });

    // ── Node 5: execute ───────────────────────────────────────
    // Every branch increments the customer's ledger counters atomically
    // (ADD, no read-modify-write) before the case is closed.
    switch (decision.action) {
      case "auto_refund": {
        const refund = await track(
          caseDoc.caseId,
          "payment.refund",
          () =>
            executeRefund(
              { caseId: caseDoc.caseId, orderId: input.orderId, customerId: input.customerId },
              decision.refundAmount!,
              `Verified ${triage.severity} damage`,
            ),
          (r) => ({ ok: r.ok, amount: r.amount, providerRefundId: r.providerRefundId, error: r.error }),
        );

        await incrementLedger(input.customerId, {
          totalRefunded: refund.amount ?? decision.refundAmount ?? 0,
          refundCount: 1,
          disputeCount: 1,
        }, { touchRefundAt: true });

        if (refund.ok) {
          await finish("auto_refunded", {
            decision: "auto_refund",
            reason: decision.reason,
            refundAmount: refund.amount ?? decision.refundAmount,
          });
        } else {
          // Provider refused (cap, state conflict) — fall to HITL with
          // the full evidence rather than retry-looping the gateway.
          const esc = await escalate(
            input,
            triage,
            telemetry.flags,
            trust,
            `Auto-refund rejected by payment service: ${refund.error}`,
          );
          await incrementLedger(input.customerId, { escalatedCount: 1 });
          await finish("escalated", {
            decision: "escalate",
            reason: decision.reason,
            escalatedTo: esc.ok ? "admin-review-queue" : "agent-review-queue",
          });
        }
        break;
      }

      case "voucher": {
        const voucher = await track(
          caseDoc.caseId,
          "voucher.issue",
          () =>
            issueVoucher(
              { caseId: caseDoc.caseId, customerId: input.customerId },
              decision.refundAmount ?? 100,
              decision.reason,
            ),
          (r) => ({ ok: r.ok, code: r.code, amount: r.amount, error: r.error }),
        );
        await incrementLedger(input.customerId, { disputeCount: 1 });
        await finish("voucher_issued", {
          decision: "voucher",
          reason: decision.reason,
          voucherCode: voucher.code,
        });
        break;
      }

      case "escalate": {
        const esc = await escalate(input, triage, telemetry.flags, trust, decision.reason);
        await incrementLedger(input.customerId, { disputeCount: 1, escalatedCount: 1 });
        await finish("escalated", {
          decision: "escalate",
          reason: decision.reason,
          escalatedTo: esc.ok ? "admin-review-queue" : "agent-review-queue",
        });
        break;
      }

      case "reject": {
        await incrementLedger(input.customerId, { disputeCount: 1 });
        await finish("rejected", { decision: "reject", reason: decision.reason });
        break;
      }
    }
  } catch (err) {
    // Node failure (tool crash, DB blip): park the case as failed with
    // whatever steps were recorded — nothing silently vanishes.
    console.error(
      `Arbitration case ${input.caseId} failed:`,
      err instanceof Error ? err.message : err,
    );
    await updateCase(caseDoc.caseId, {
      status: "failed",
      decisionReason: err instanceof Error ? err.message : "Unknown node failure",
      finishedAt: nowIso(),
    }).catch(() => {});
    publishAgentEvent("agent.case_failed", { caseId: caseDoc.caseId, error: String(err) });
  }

  return getCase(caseDoc.caseId);
};

// ─── HITL escalation helper ──────────────────────────────────
// LLM writes the evidence summary; the case row + review item carry
// everything a human needs (no second round-trip to the case).

async function escalate(
  input: ArbitrationInput,
  triage: { severity: DamageSeverity; suspicious: boolean; confidence: number },
  telemetryFlags: string[],
  trust: TrustAssessment,
  reason: string,
): Promise<{ ok: boolean; summary: string }> {
  const { json } = await callLlm({
    system:
      'You summarize dispute evidence for a human reviewer. Return STRICT JSON: {"summary": "<max 4 sentences>", "recommendation": "<refund|voucher|reject>", "confidence": <0.0-1.0>}',
    userText: buildEscalationContext(input, triage, telemetryFlags, trust, reason),
    maxTokens: 400,
  });

  return escalateToHuman(
    {
      caseId: input.caseId,
      orderId: input.orderId,
      customerId: input.customerId,
      complaint: input.complaint,
      damageSeverity: triage.severity,
      trustScore: trust.score,
      telemetryFlags,
    },
    {
      evidenceSummary: String(
        json?.summary ??
          "Vision triage, telemetry and trust signals gave conflicting or insufficient evidence for an autonomous decision.",
      ),
      recommendation: String(json?.recommendation ?? "review"),
    },
  );
}

function buildEscalationContext(
  input: ArbitrationInput,
  triage: { severity: DamageSeverity; suspicious: boolean; confidence: number },
  telemetryFlags: string[],
  trust: TrustAssessment,
  reason: string,
): string {
  return [
    `Why escalated: ${reason}`,
    `Complaint: ${input.complaint.slice(0, 300)}`,
    `Photo: ${input.photoUrl ? "stored on Cloudinary" : "not provided"}`,
    `Vision triage: severity=${triage.severity}, confidence=${triage.confidence.toFixed(2)}, suspicious=${triage.suspicious}`,
    `Telemetry flags: ${telemetryFlags.length ? telemetryFlags.join(", ") : "none"}`,
    `Trust: score=${trust.score.toFixed(2)} tier=${trust.tier} orders=${trust.ordersCompleted} refundRate=${trust.refundRate.toFixed(2)}`,
    `Signals: ${trust.signals.join(", ") || "none"}`,
  ].join("\n");
}

// ─── Decision node (deterministic policy — the LLM never decides) ──

function decide(
  triage: { severity: DamageSeverity; suspicious: boolean; confidence: number },
  telemetryFlags: string[],
  trust: TrustAssessment,
  hasPhoto: boolean,
): { action: AgentAction; refundAmount: number | null; reason: string } {
  // No photo → nothing verifiable → human reviews the claim
  if (!hasPhoto) {
    return { action: "escalate", refundAmount: null, reason: "No photo evidence provided" };
  }

  // Download failed / evidence unreadable, or vision tier down → HITL
  if (triage.severity === "unclear") {
    return { action: "escalate", refundAmount: null, reason: "Damage evidence unclear or unavailable" };
  }

  // Photo contradicts the complaint text: chronic complainers with
  // contradicting evidence get rejected outright; everyone else → HITL
  if (triage.suspicious) {
    if (trust.score < 0.45) {
      return {
        action: "reject",
        refundAmount: null,
        reason: "Photo contradicts complaint and customer has an elevated dispute history",
      };
    }
    return { action: "escalate", refundAmount: null, reason: "Photo contradicts complaint text" };
  }

  // Verified, visible damage
  if (SEVERITY_REFUND.includes(triage.severity)) {
    // Detour or rough-handling flags corroborate damage — trust the
    // customer's account and refund even at medium trust
    const corroborated = telemetryFlags.length > 0;

    if (trust.score >= 0.7 || (corroborated && trust.score >= 0.45)) {
      return {
        action: "auto_refund",
        refundAmount: MAX_AUTO_REFUND, // utils caps to order total anyway
        reason: `Verified ${triage.severity} damage; trust ${trust.tier}${corroborated ? " + telemetry corroboration" : ""}`,
      };
    }

    // Borderline trust — goodwill voucher instead of cash
    return {
      action: "voucher",
      refundAmount: 100,
      reason: "Verified damage but trust score below autonomous-refund threshold",
    };
  }

  // Minor damage: goodwill gesture, never cash without a human
  if (triage.severity === "minor") {
    return {
      action: "voucher",
      refundAmount: 75,
      reason: "Minor cosmetic damage — goodwill voucher",
    };
  }

  // severity === "none": the photo shows an intact order
  if (triage.severity === "none") {
    return {
      action: "reject",
      refundAmount: null,
      reason: "Photo shows an intact, correct order",
    };
  }

  // Default safety net
  return { action: "escalate", refundAmount: null, reason: "Policy fallback — unclassified evidence" };
}
