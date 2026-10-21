import { Request, Response } from "express";
import { v2 as cloudinary } from "cloudinary";
import {
  createVerification,
  findRecentVerification,
  listVerificationsByOrder,
  type Verification,
} from "@foodo/backend-common/dynamo";
import { verifyImage, type AiVerificationResult } from "../config/ai.js";
import { publishVerificationEvent } from "../config/events.js";
import { runProvider } from "../config/http.js";
import { tryCatch } from "../middlewares/trycatch.js";

// ─── Verdict persistence + evidence ──────────────────────────
// Verdicts live in the shared DynamoDB verifications table (TTL
// bounded); the evidence photo lives in Cloudinary. The verdict is
// ephemeral; the photo is the legal record.
//
// The AI chain is allowed to be DOWN: the caller gets
// status "unverified" (never a 5xx), the row is still written, and
// the gap is visible to downstream consumers instead of silently
// passing an order.

const EVIDENCE_TTL_DAYS = Number(process.env.VERIFICATION_TTL_DAYS) || 90;

// ─── Cloudinary evidence copy ─────────────────────────────────
// The photo is the dispute record — it must outlive the AI verdict.
// Goes through the shared external-egress breaker so a Cloudinary
// outage fails fast and trips ONE shared circuit instead of piling
// up sockets.
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

type Actors = {
  restaurantId?: string | null;
  riderId?: string | null;
  customerId?: string | null;
};

const eventName = (type: "packing" | "delivery") =>
  type === "packing" ? "verification.packing" : "verification.delivery";

async function persist(
  orderId: string,
  type: "packing" | "delivery",
  actors: Actors,
  verdict: {
    status: "verified" | "flagged" | "unverified";
    flag: string | null;
    confidence: number;
    detected: string[];
    missing: string[];
    unexpected: string[];
    notes: string | null;
    provider: string | null;
    unverifiedReason?: string | null;
  },
  image: { url: string | null; publicId: string | null },
): Promise<Verification> {
  const row = await createVerification({
    orderId,
    type,
    restaurantId: actors.restaurantId ?? null,
    riderId: actors.riderId ?? null,
    customerId: actors.customerId ?? null,
    status: verdict.status,
    flag: verdict.flag,
    confidence: verdict.confidence,
    detected: verdict.detected,
    missing: verdict.missing,
    unexpected: verdict.unexpected,
    notes: verdict.notes,
    provider: verdict.provider,
    unverifiedReason: verdict.unverifiedReason ?? null,
    image,
    retentionDays: EVIDENCE_TTL_DAYS,
  });

  await publishVerificationEvent(eventName(type), {
    ...row,
    evidenceUri: image.url ? "stored" : "not_stored",
  });

  return row;
}

// ─── Idempotency window ──────────────────────────────────────
// Rapid double-taps (or a retrying client) must not double-spend AI
// calls or fork the audit trail. A recent verdict for the same
// order+type is returned as-is.
const RECHECK_COOLDOWN_MS = 60_000;

// ─── POST /api/verification/packing ──────────────────────────
// Body: { orderId, restaurantId, expected: { itemId, name, quantity }[], image }
// Auth: internal service key (restaurant service forwards, holding the
// seller's session server-side — the browser never talks here).
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
  const recent = await findRecentVerification(
    String(orderId),
    "packing",
    RECHECK_COOLDOWN_MS,
  );
  if (recent) {
    return res.status(200).json({ ...recent, deduped: true });
  }

  // Evidence first (independent of the AI call), then verdict.
  const evidence = await storeEvidence(image);
  const result = await verifyImage(image, {
    mode: "packing",
    expectedItems: expected.map((e) => ({
      name: String(e?.name ?? "").slice(0, 120),
      quantity: Math.max(1, Math.min(50, Number(e?.quantity) || 1)),
    })),
  });

  if (!result) {
    const row = await persist(
      String(orderId),
      "packing",
      { restaurantId },
      {
        status: "unverified",
        flag: "AI_UNAVAILABLE",
        confidence: 0,
        detected: [],
        missing: [],
        unexpected: [],
        notes: null,
        provider: null,
        unverifiedReason:
          "AI verification chain unavailable (both providers down or unconfigured)",
      },
      evidence,
    );
    return res.status(200).json({ ...row, evidence });
  }

  const row = await persist(
    String(orderId),
    "packing",
    { restaurantId },
    {
      status: result.status,
      flag: result.flag,
      confidence: result.confidence,
      detected: result.detected,
      missing: result.missing,
      unexpected: result.unexpected,
      notes: result.notes,
      provider: result.provider,
    },
    evidence,
  );
  return res.status(200).json({ ...row, evidence });
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
  const recent = await findRecentVerification(
    String(orderId),
    "delivery",
    RECHECK_COOLDOWN_MS,
  );
  if (recent) {
    return res.status(200).json({ ...recent, deduped: true });
  }

  const evidence = await storeEvidence(image);
  const result = await verifyImage(image, {
    mode: "delivery",
    deliveryAddress:
      typeof deliveryAddress === "string" ? deliveryAddress.slice(0, 300) : null,
  });

  if (!result) {
    const row = await persist(
      String(orderId),
      "delivery",
      { riderId, customerId },
      {
        status: "unverified",
        flag: "AI_UNAVAILABLE",
        confidence: 0,
        detected: [],
        missing: [],
        unexpected: [],
        notes: null,
        provider: null,
        unverifiedReason:
          "AI verification chain unavailable (both providers down or unconfigured)",
      },
      evidence,
    );
    return res.status(200).json({ ...row, evidence });
  }

  const row = await persist(
    String(orderId),
    "delivery",
    { riderId, customerId },
    {
      status: result.status,
      flag: result.flag,
      confidence: result.confidence,
      detected: result.detected,
      missing: result.missing,
      unexpected: result.unexpected,
      notes: result.notes,
      provider: result.provider,
    },
    evidence,
  );
  return res.status(200).json({ ...row, evidence });
});

// ─── GET /api/verification/order/:orderId ────────────────────
// Audit read — every verdict for an order (packing + delivery).
// Auth: internal service key. Used by support/dispute tooling.
export const getVerificationsForOrder = tryCatch(async (req: Request, res: Response) => {
  const orderId = String(req.params?.orderId ?? "");
  if (!orderId) {
    return res.status(400).json({ message: "orderId is required" });
  }

  const verifications = await listVerificationsByOrder(orderId);
  return res.status(200).json({ success: true, count: verifications.length, verifications });
});
