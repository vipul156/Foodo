import { Request, Response } from "express";
import { v2 as cloudinary } from "cloudinary";
import { Verification } from "../models/Verification.js";
import { verifyImage, type AiVerificationResult } from "../config/ai.js";
import { publishVerificationEvent } from "../config/verification.producer.js";
import { runProvider } from "../config/http.js";
import { tryCatch } from "../middlewares/trycatch.js";

// ─── Evidence retention ──────────────────────────────────────
// Verdicts + photos age out. 90 days covers chargeback windows and
// platform dispute SLAs; keeps the collection bounded forever.
const EVIDENCE_TTL_DAYS = Number(process.env.VERIFICATION_TTL_DAYS) || 90;

const evidenceExpiry = () =>
  new Date(Date.now() + EVIDENCE_TTL_DAYS * 24 * 60 * 60 * 1000);

// ─── Cloudinary evidence copy ────────────────────────────────
// The photo is the dispute record — it must outlive the AI verdict.
// Goes through the shared payment-provider breaker (external egress,
// 8s leeway) so a Cloudinary outage fails fast and trips ONE shared
// circuit instead of piling up sockets.
async function storeEvidence(
  dataUri: string,
): Promise<{ url: string | null; publicId: string | null }> {
  try {
    const cloud = await runProvider(() => cloudinary.uploader.upload(dataUri));
    return { url: cloud.secure_url, publicId: cloud.public_id };
  } catch (err) {
    // Evidence storage is critical for disputes but NOT for the packing
    // gate: record the failure, still return the AI verdict, and let the
    // record carry url=null. Retry-friendly and auditable.
    console.error(
      "Evidence upload failed (continuing without stored copy):",
      err instanceof Error ? err.message : err,
    );
    return { url: null, publicId: null };
  }
}

// ─── Persistence (AI chain down → status "unverified") ───────
// A dead AI tier must NOT silently pass or fail an order. The verdict
// is recorded as "unverified" with a reason, the seller still gets a
// UI warning, and a later retry can upgrade it — fully auditable.

async function persistUnverified(
  orderId: string,
  type: "packing" | "delivery",
  reason: string,
  actors: { restaurantId?: string | null; riderId?: string | null; customerId?: string | null },
  image: { url: string | null; publicId: string | null },
  evidenceUri: string | null,
) {
  const doc = await Verification.create({
    orderId,
    type,
    restaurantId: actors.restaurantId ?? null,
    riderId: actors.riderId ?? null,
    customerId: actors.customerId ?? null,
    status: "unverified",
    flag: "AI_UNAVAILABLE",
    confidence: 0,
    provider: null,
    unverifiedReason: reason,
    image,
    expiresAt: evidenceExpiry(),
  });
  publishVerificationEvent(
    type === "packing" ? "verification.packing" : "verification.delivery",
    { ...doc.toObject(), evidenceUri: evidenceUri ? "stored" : "not_stored" },
  );
  return doc;
}

async function persistResult(
  orderId: string,
  type: "packing" | "delivery",
  result: AiVerificationResult,
  actors: { restaurantId?: string | null; riderId?: string | null; customerId?: string | null },
  image: { url: string | null; publicId: string | null },
) {
  const doc = await Verification.create({
    orderId,
    type,
    restaurantId: actors.restaurantId ?? null,
    riderId: actors.riderId ?? null,
    customerId: actors.customerId ?? null,
    status: result.status,
    flag: result.flag,
    confidence: result.confidence,
    detected: result.detected,
    missing: result.missing,
    unexpected: result.unexpected,
    notes: result.notes,
    provider: result.provider,
    image,
    expiresAt: evidenceExpiry(),
  });
  publishVerificationEvent(
    type === "packing" ? "verification.packing" : "verification.delivery",
    doc,
  );
  return doc;
}

// ─── Idempotency window ──────────────────────────────────────
// Rapid double-taps (or a retrying client) must not double-spend AI
// calls or fork the audit trail. A recent verdict for the same
// order+type is returned as-is.

const RECHECK_COOLDOWN_MS = 60_000;

// ─── POST /api/verification/packing ──────────────────────────────
// Body: { orderId, restaurantId, expected: { itemId, name, quantity }[], image }
// Auth: internal service key (restaurant service forwards, holding the
// seller's session server-side — the browser never talks to utils).
//
// Response contract (NEVER 5xx on AI failure — the caller gates on
// `status`, not on HTTP errors):
//   200 { status: "verified" | "flagged" | "unverified", flag, confidence,
//         detected, missing, unexpected, notes, provider, evidence }

export const verifyPacking = tryCatch(async (req: Request, res: Response) => {
  const { orderId, restaurantId, expected, image } = req.body ?? {};

  if (!orderId || !Array.isArray(expected) || expected.length === 0 || !image) {
    return res.status(400).json({ message: "orderId, expected items and image are required" });
  }

  // Idempotent re-check within the cooldown window
  const recent = await Verification.findOne({
    orderId,
    type: "packing",
    createdAt: { $gt: new Date(Date.now() - RECHECK_COOLDOWN_MS) },
  }).sort({ createdAt: -1 });
  if (recent) {
    return res.status(200).json({ ...recent.toObject(), deduped: true });
  }

  // Evidence first (independent of the AI call), then verdict.
  // Evidence upload goes through the shared external-egress breaker —
  // a Cloudinary outage fails fast here instead of stacking sockets.
  const evidence = await storeEvidence(image);
  const result = await verifyImage(image, {
    mode: "packing",
    expectedItems: expected.map((e) => ({
      name: String(e?.name ?? "").slice(0, 120),
      quantity: Math.max(1, Math.min(50, Number(e?.quantity) || 1)),
    })),
  });

  if (!result) {
    const doc = await persistUnverified(
      orderId,
      "packing",
      "AI verification chain unavailable (both providers down or unconfigured)",
      { restaurantId },
      evidence,
      image,
    );
    return res.status(200).json({ ...doc.toObject(), evidence });
  }

  const doc = await persistResult(orderId, "packing", result, { restaurantId }, evidence);
  return res.status(200).json({ ...doc.toObject(), evidence });
});

// ─── POST /api/verification/delivery ─────────────────────────
// Body: { orderId, riderId, customerId, deliveryAddress, image }
// Auth: internal service key (rider service forwards).
//
// POD here is advisory evidence (AppSec anti-fraud), NOT a hard gate —
// delivery proceeds even when flagged, because a false block strands a
// customer's paid food. Flagged verdicts are persisted and published so
// dispute/fraud workflows can act.

export const verifyDelivery = tryCatch(async (req: Request, res: Response) => {
  const { orderId, riderId, customerId, deliveryAddress, image } = req.body ?? {};

  if (!orderId || !image) {
    return res.status(400).json({ message: "orderId and image are required" });
  }

  // Idempotent re-check within the cooldown window
  const recent = await Verification.findOne({
    orderId,
    type: "delivery",
    createdAt: { $gt: new Date(Date.now() - RECHECK_COOLDOWN_MS) },
  }).sort({ createdAt: -1 });
  if (recent) {
    return res.status(200).json({ ...recent.toObject(), deduped: true });
  }

  const evidence = await storeEvidence(image);
  const result = await verifyImage(image, {
    mode: "delivery",
    deliveryAddress:
      typeof deliveryAddress === "string" ? deliveryAddress.slice(0, 300) : null,
  });

  if (!result) {
    const doc = await persistUnverified(
      orderId,
      "delivery",
      "AI verification chain unavailable (both providers down or unconfigured)",
      { riderId, customerId },
      evidence,
      image,
    );
    return res.status(200).json({ ...doc.toObject(), evidence });
  }

  const doc = await persistResult(orderId, "delivery", result, { riderId, customerId }, evidence);
  return res.status(200).json({ ...doc.toObject(), evidence });
});

// ─── GET /api/verification/order/:orderId ────────────────────
// Audit read — every verdict for an order (packing + delivery).
// Auth: internal service key. Used by support/dispute tooling.

export const getVerificationsForOrder = tryCatch(async (req: Request, res: Response) => {
  const orderId = req.params?.orderId;
  if (!orderId) {
    return res.status(400).json({ message: "orderId is required" });
  }

  const verifications = await Verification.find({ orderId }).sort({ createdAt: -1 });
  return res.status(200).json({ success: true, count: verifications.length, verifications });
});
