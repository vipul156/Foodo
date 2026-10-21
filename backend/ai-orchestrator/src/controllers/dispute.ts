import { listEscalatedCases, getCase as getCaseRow } from "../dynamo/cases.js";
import { runArbitration } from "../graph/arbitration.graph.js";
import { generateCaseId } from "../graph/caseId.js";
import { publishDisputeWorkItem } from "../config/events.js";
import { storeDisputeEvidence } from "../config/photo.js";
import { tryCatch } from "../middlewares/trycatch.js";
import type { Request, Response } from "express";

// ─── Dispute intake + case queries ───────────────────────────
// Disputes arrive via two doors:
//   1. HTTP   POST /api/agent/dispute (the app's support form)
//   2. SQS    agent-disputes work items (chat/email channels) — see
//             handlers/disputeConsumer.ts, the SAME queue this intake
//             enqueues onto.
//
// Both funnel into the same arbitration graph. The HTTP door does NOT
// run the graph inline: a Lambda handler's background work is frozen
// once the response returns, so intake does the synchronous must-happens
// (evidence upload) and hands the case to the consumer Lambda — the
// replacement for the old fire-and-forget `void runArbitration(...)`.

interface DisputeBody {
  orderId?: unknown;
  customerId?: unknown;
  complaint?: unknown;
  channel?: unknown;
  image?: unknown;
}

const DATA_URI_PATTERN = /^data:[a-zA-Z0-9/+.-]+;base64,(.+)$/s;
const MAX_IMAGE_BASE64_CHARS = 14_000_000; // ≈10 MB binary

// ─── POST /api/agent/dispute ─────────────────────────────────
// Body: { orderId, customerId, complaint (min 5 chars), channel?, image? }
// Image is a base64 data URI, same capture pipeline as verification.
//
// Response contract:
//   202 { success, caseId }             — queued for arbitration
//   503 { message }                     — evidence store unreachable
export const submitDispute = tryCatch(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as DisputeBody;

  const orderId = typeof body.orderId === "string" ? body.orderId.trim() : "";
  const customerId = typeof body.customerId === "string" ? body.customerId.trim() : "";
  const complaint = typeof body.complaint === "string" ? body.complaint.trim() : "";

  if (!orderId || !customerId || complaint.length < 5) {
    return res.status(400).json({
      message: "orderId, customerId and a complaint (min 5 chars) are required",
    });
  }

  const channel =
    body.channel === "chat" || body.channel === "email" ? body.channel : "app";

  // Photo arrives as a data URI. It goes straight to Cloudinary — the
  // queue can't carry it (256 KB limit) and the case row stores only
  // the URL. A failed upload fails the intake: better for the client
  // to retry while it still holds the photo than to enqueue a case
  // that can only ever escalate on missing evidence.
  let photoUrl: string | null = null;
  if (typeof body.image === "string" && body.image.length > 0) {
    if (body.image.length > MAX_IMAGE_BASE64_CHARS) {
      return res.status(413).json({ message: "Photo too large (max ~10MB)" });
    }
    const match = DATA_URI_PATTERN.exec(body.image);
    const dataUri = match ? `data:image/jpeg;base64,${match[1]}` : body.image;
    try {
      photoUrl = (await storeDisputeEvidence(dataUri)).photoUrl;
    } catch (err) {
      console.error(
        "Evidence upload failed — rejecting intake:",
        err instanceof Error ? err.message : err,
      );
      return res.status(503).json({
        message: "Could not store the photo right now — try again",
      });
    }
  }

  const caseId = generateCaseId();

  // Enqueue — the consumer Lambda runs the full graph. A publish
  // failure reaches the client as 502 (no ticket was created; the
  // client retries instead of polling a case that never runs).
  try {
    await publishDisputeWorkItem({
      caseId,
      orderId,
      customerId,
      complaint,
      channel,
      photoUrl,
    });
  } catch (err) {
    console.error(
      `Dispute enqueue failed for ${caseId}:`,
      err instanceof Error ? err.message : err,
    );
    return res.status(502).json({
      message: "Could not queue the dispute — try again",
    });
  }

  return res.status(202).json({
    success: true,
    caseId,
    message: "Arbitration queued — poll /api/agent/case/:caseId for progress",
  });
});

// ─── GET /api/agent/case/:caseId ─────────────────────────────
// Full case record including every tool step (the thought graph).

export const getCase = tryCatch(async (req: Request, res: Response) => {
  // Express 5 types params as string | string[]; a repeated param is a
  // client bug — take the first value.
  const rawCaseId = req.params?.caseId;
  const caseId = Array.isArray(rawCaseId) ? rawCaseId[0] : rawCaseId;
  if (!caseId) {
    return res.status(400).json({ message: "caseId is required" });
  }

  const caseDoc = await getCaseRow(caseId);
  if (!caseDoc) {
    return res.status(404).json({ message: "Case not found" });
  }
  return res.status(200).json({ success: true, case: caseDoc });
});

// ─── GET /api/agent/queue ────────────────────────────────────
// Review queue — escalated cases awaiting a human decision.
// Internal-key gated (admin tooling polls this).

export const getEscalatedQueue = tryCatch(async (req: Request, res: Response) => {
  const rawLimit = req.query?.limit;
  const limit = Math.min(
    100,
    Math.max(1, Number(Array.isArray(rawLimit) ? rawLimit[0] : rawLimit) || 25),
  );
  const cases = await listEscalatedCases(limit);
  return res.status(200).json({ success: true, count: cases.length, cases });
});
