import { ArbitrationCase } from "../models/ArbitrationCase.js";
import { runArbitration } from "../graph/arbitration.graph.js";
import { generateCaseId } from "../graph/caseId.js";
import { tryCatch } from "../middlewares/trycatch.js";
import type { Request, Response } from "express";

// ─── Dispute intake + case queries ───────────────────────────
// Disputes arrive via two doors:
//   1. HTTP  POST /api/agent/dispute  (frontend support form → this
//      service proxies nothing; the caller posts complaint text and an
//      optional photo)
//   2. RabbitMQ "order.disputed" events (chat/email channels land here)
// Both funnel into the same arbitration graph.

interface DisputeBody {
  orderId?: unknown;
  customerId?: unknown;
  complaint?: unknown;
  channel?: unknown;
  image?: unknown;
}

export const submitDispute = tryCatch(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as DisputeBody;

  const orderId = typeof body.orderId === "string" ? body.orderId : null;
  const customerId = typeof body.customerId === "string" ? body.customerId : null;
  const complaint = typeof body.complaint === "string" ? body.complaint.trim() : "";

  if (!orderId || !customerId || complaint.length < 5) {
    return res.status(400).json({
      message: "orderId, customerId and a complaint (min 5 chars) are required",
    });
  }

  const channel =
    body.channel === "chat" || body.channel === "email" ? body.channel : "app";

  // Photo arrives as a data URI (same capture pipeline as verification);
  // strip the prefix for the vision call, cap the size defensively.
  let photoBase64: string | null = null;
  if (typeof body.image === "string" && body.image.length > 0) {
    if (body.image.length > 14_000_000) {
      return res.status(413).json({ message: "Photo too large (max ~10MB)" });
    }
    const match = /^data:[a-zA-Z0-9/+.-]+;base64,(.+)$/s.exec(body.image);
    photoBase64 = match?.[1] ?? body.image;
  }

  const caseId = generateCaseId();

  // The base64 photo is passed to the graph in-memory only — the case
  // document stores metadata + evidence URLs, never megabytes of image.

  // Run the graph asynchronously — the API responds immediately with the
  // caseId so the support UI can poll/stream progress.
  void runArbitration({
    caseId,
    orderId,
    customerId,
    complaint,
    photoBase64,
    channel,
  }).catch((err) =>
    console.error(`Background arbitration failed for ${caseId}:`, err?.message),
  );

  return res.status(202).json({
    success: true,
    caseId,
    message: "Arbitration started — poll /api/agent/case/:caseId for progress",
  });
});

// ─── GET /api/agent/case/:caseId ─────────────────────────────
// Full case record including every tool step (the thought graph).

export const getCase = tryCatch(async (req: Request, res: Response) => {
  const caseId = req.params?.caseId;
  if (!caseId) {
    return res.status(400).json({ message: "caseId is required" });
  }

  const caseDoc = await ArbitrationCase.findOne({ caseId });
  if (!caseDoc) {
    return res.status(404).json({ message: "Case not found" });
  }
  return res.status(200).json({ success: true, case: caseDoc });
});

// ─── GET /api/agent/queue ────────────────────────────────────
// Admin review queue — escalated cases awaiting a human decision.
// Internal-key gated (admin service polls this).

export const getEscalatedQueue = tryCatch(async (req: Request, res: Response) => {
  const limit = Math.min(100, Math.max(1, Number(req.query?.limit) || 25));
  const cases = await ArbitrationCase.find({ status: "escalated" })
    .sort({ createdAt: -1 })
    .limit(limit);
  return res.status(200).json({ success: true, count: cases.length, cases });
});
