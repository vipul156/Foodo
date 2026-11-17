import type { AuthRequest } from "@foodo/backend-common";
import { tryCatch } from "@foodo/backend-common";
import {
  getRiderByUserId,
  findCurrentOrderForRider,
} from "@foodo/backend-common/dynamo";
import { publishRiderEvent } from "../config/events.js";

// ─── Proof of Delivery (rider service) ───────────────────────
// Flow: rider taps "Delivered" → snaps a drop-off photo → THIS service
// verifies delivery context (the photo is verified against the rider's
// OWN current order — never a client-supplied orderId, which would let
// a rider "verify" arbitrary orders) → ai-verification produces the
// verdict → delivery completes via the existing status-change event.
//
// Policy: POD here is ANTI-FRAUD EVIDENCE, not a hard delivery gate.
// A flagged verdict never blocks completion — a false positive would
// strand a paid customer's food. The verdict is persisted + published
// by ai-verification, so dispute/fraud workflows see it regardless of
// whether the delivery completed.

const VERIFICATION_TIMEOUT_MS = Number(process.env.VERIFICATION_TIMEOUT_MS) || 25_000;
const MAX_IMAGE_BASE64_CHARS = 14_000_000; // ≈10MB binary

interface PodVerdict {
  status: "verified" | "flagged" | "unverified";
  flag?: string | null;
  confidence?: number;
  detected?: string[];
  notes?: string | null;
  provider?: string | null;
  unverifiedReason?: string | null;
  deduped?: boolean;
  image?: { url?: string | null; publicId?: string | null };
  evidence?: { url?: string | null; publicId?: string | null };
}

// ─── POST /api/rider/order/pod ───────────────────────────────
// Auth: rider. Body: { image: string } — photo of the drop-off.
// The order is implied: the rider's OWN current delivery.
export const submitProofOfDelivery = tryCatch(async (req: AuthRequest, res) => {
  const riderUserId = req.user?.id;
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

  const rider = await getRiderByUserId(String(riderUserId));
  if (!rider) {
    return res.status(404).json({ message: "Rider not found" });
  }

  // Resolve the current order server-side. No current order → nothing
  // to verify (the rider app only shows the camera on an active trip).
  let currentOrder: Awaited<ReturnType<typeof findCurrentOrderForRider>> = null;
  try {
    currentOrder = await findCurrentOrderForRider(rider.id);
  } catch {
    return res.status(503).json({
      message: "Could not reach order service — try again",
    });
  }
  if (!currentOrder) {
    return res.status(409).json({ message: "No active delivery to verify" });
  }
  const orderId = String(currentOrder.id);

  // ─── AI verdict (advisory — never blocks delivery) ─────────
  let verdict: PodVerdict | null = null;
  try {
    const response = await fetch(
      `${process.env.AI_VERIFICATION_URL ?? ""}/api/verification/delivery`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-key": process.env.INTERNAL_SERVICE_KEY ?? "",
        },
        body: JSON.stringify({
          orderId,
          riderId: rider.id,
          customerId: currentOrder.userId,
          deliveryAddress: currentOrder.deliveryAddress?.formattedAddress ?? null,
          image,
        }),
        signal: AbortSignal.timeout(VERIFICATION_TIMEOUT_MS),
      },
    );
    if (response.ok) {
      verdict = (await response.json()) as PodVerdict;
    } else {
      // A 4xx always means our forward payload is malformed; 5xx means
      // the AI tier is saturating. Either way: degrade, don't retry
      // inline — the rider can retry the same call later.
      console.error(
        `POD verification failed (${response.status}) for order ${orderId}`,
      );
    }
  } catch (err) {
    console.error(
      "POD verification unreachable (delivery can still complete):",
      err instanceof Error ? err.message : err,
    );
  }

  // ─── Complete the delivery ──────────────────────────────────
  // Same contract as PUT /order/update: publish the intent and let the
  // order owner apply the transition (idempotent, from-status guarded).
  // The POD verdict is already persisted on the verification side, so
  // evidence exists even if this publish fails and the rider retries.
  const published = await publishRiderEvent("rider.order_status_changed", {
    orderId,
    riderId: rider.id,
  });

  const verification = {
    status: verdict?.status ?? ("unverified" as const),
    flag: verdict?.flag ?? "VERIFY_UNAVAILABLE",
    confidence: verdict?.confidence ?? 0,
    notes: verdict?.notes ?? null,
    evidenceUrl: verdict?.evidence?.url ?? verdict?.image?.url ?? null,
    provider: verdict?.provider ?? null,
    deduped: Boolean(verdict?.deduped),
  };

  if (!published) {
    // Delivery NOT completed — the rider app retries this endpoint.
    // The verdict is durable; nothing is lost by the retry.
    return res.status(503).json({
      message: "Delivery completion failed — retry from the app",
      verification,
    });
  }

  return res.status(200).json({
    success: true,
    message:
      verification.status === "flagged"
        ? "Delivery completed — the drop-off photo was flagged for review"
        : "Delivery completed",
    verification,
  });
});
