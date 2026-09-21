import { AuthRequest } from "../middlewares/isAuth.js";
import { tryCatch } from "../middlewares/trycatch.js";
import { Rider } from "../model/Rider.js";
import { readGet, readPost, verifyPost } from "../config/http.js";
import { getInternalHeaders } from "./rider.js";

// ─── Proof of Delivery (rider service) ───────────────────────
// Flow: rider taps "Delivered" → snaps a drop-off photo → rider service
// verifies delivery context (the photo must be for the rider's OWN
// current order) → proxies to the utils AI tier → the verdict is
// attached to the order and delivery completes.
//
// Policy: POD here is ANTI-FRAUD EVIDENCE, not a hard delivery gate.
// A flagged verdict never blocks completion — a false positive would
// strand a paid customer's food. Instead the verdict rides along on the
// order document (attached via the restaurant service) so dispute and
// fraud workflows can act, and the rider app shows what was detected.

interface PodVerdict {
  status: "verified" | "flagged" | "unverified";
  flag?: string | null;
  confidence?: number;
  detected?: string[];
  notes?: string | null;
  provider?: string | null;
  unverifiedReason?: string | null;
  evidence?: { url?: string | null; publicId?: string | null };
  image?: { url?: string | null };
}

const MAX_IMAGE_BASE64_CHARS = 14_000_000; // ≈10MB binary

// ─── POST /api/rider/order/pod ───────────────────────────────
// Auth: rider. Body: { image: string } — photo of the drop-off.
// The order is implied: the rider's OWN current delivery (never a
// client-supplied orderId — that would let a rider "verify" arbitrary
// orders).

export const submitProofOfDelivery = tryCatch(async (req: AuthRequest, res) => {
  const riderUserId = req.user?._id;
  if (!riderUserId) {
    return res.status(401).json({ message: "You are not authorized" });
  }

  const { image } = req.body ?? {};
  if (typeof image !== "string" || image.length === 0) {
    return res.status(400).json({ message: "Drop-off photo is required" });
  }
  if (image.length > MAX_IMAGE_BASE64_CHARS) {
    return res.status(413).json({ message: "Drop-off photo too large (max ~10MB)" });
  }

  const rider = await Rider.findOne({ userId: riderUserId });
  if (!rider) {
    return res.status(404).json({ message: "Rider not found" });
  }

  // Resolve the current order server-side. No current order → nothing
  // to verify (the rider app only shows the camera on an active trip).
  interface CurrentOrder {
    _id: string;
    userId?: string;
    deliveryAddress?: { formattedAddress?: string };
    status?: string;
  }
  let currentOrder: CurrentOrder | null = null;
  try {
    const data = await readGet<{ order?: CurrentOrder | null }>(
      `${process.env.RESTAURANT_SERVICE_URL}/api/order/current/rider?riderId=${rider._id}`,
      { headers: getInternalHeaders() },
    );
    currentOrder = data.order ?? null;
  } catch {
    return res.status(502).json({
      message: "Could not reach order service — try again",
    });
  }

  if (!currentOrder?._id) {
    return res.status(409).json({ message: "No active delivery to verify" });
  }

  const orderId = String(currentOrder._id);

  const verdict = await verifyPost<PodVerdict>(
    `${process.env.UTILS_SERVICE_URL}/api/utils/verification/delivery`,
    {
      orderId,
      riderId: String(rider._id),
      customerId: currentOrder.userId ? String(currentOrder.userId) : null,
      deliveryAddress: currentOrder.deliveryAddress?.formattedAddress ?? null,
      image,
    },
    { headers: getInternalHeaders() },
  );

  if (!verdict || typeof verdict.status !== "string") {
    return res.status(502).json({
      message: "Verification service unavailable — delivery can still complete, try again later",
    });
  }

  // Complete the delivery WITH the attached POD verdict. Best-effort
  // attach detail: if the status update fails the rider retries via the
  // normal flow — the AI verdict is already persisted on the utils side,
  // so evidence exists regardless.
  let attached = false;
  try {
    await readPost(
      `${process.env.RESTAURANT_SERVICE_URL}/api/order/update/status/rider`,
      {
        orderId,
        status: "delivered",
        proofOfDelivery: {
          status: verdict.status,
          flag: verdict.flag ?? null,
          confidence: verdict.confidence ?? 0,
          notes: verdict.notes ?? null,
          evidenceUrl: verdict.evidence?.url ?? verdict.image?.url ?? null,
        },
      },
      { headers: getInternalHeaders() },
    );
    attached = true;
  } catch (err) {
    console.error(
      "POD attach failed (rider should retry delivery completion):",
      err instanceof Error ? err.message : err,
    );
  }

  return res.status(200).json({
    success: true,
    message: attached
      ? "Delivery completed with verified proof"
      : "Proof verified — complete the delivery to attach it",
    verification: {
      status: verdict.status,
      flag: verdict.flag ?? null,
      confidence: verdict.confidence ?? 0,
      notes: verdict.notes ?? null,
      evidenceUrl: verdict.evidence?.url ?? null,
      provider: verdict.provider ?? null,
      attached,
    },
  });
});
