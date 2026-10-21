import { tryCatch, type AuthRequest } from "@foodo/backend-common";
import type { DynamoOrder } from "@foodo/backend-common/dynamo";
import {
  getOrderById,
  getRestaurantById,
  setPackingVerification,
  setPackingVerificationOverride,
} from "@foodo/backend-common/dynamo";

// ─── Packing verification (restaurant service) ───────────────
// The kitchen flow: seller packs → snapshots the open bag → this service
// validates ownership, builds the expected ticket from the ORDER (not
// the client), and proxies to the ai-verification service. The verdict
// comes back synchronously so the kitchen screen can warn BEFORE
// sealing the bag, and the denormalized summary is stamped on the
// order (the full AI row lives in the verifications table).
//
// Trust boundaries:
//   - Expected items are read from the stored order item — a client
//     can never claim "expected: 1x item" to launder a short-pack.
//   - Ownership is checked against the stored restaurant record.
//   - The image is a base64 data URI from the browser upload; the
//     verification service re-validates mime + size independently.

const MAX_IMAGE_BASE64_CHARS = 14_000_000; // ≈10MB binary
const VERIFICATION_TIMEOUT_MS = Number(process.env.VERIFICATION_TIMEOUT_MS) || 25_000;

const gateStatuses = ["placed", "accepted", "preparing", "ready_for_rider"];

interface VerificationVerdict {
  status: "verified" | "flagged" | "unverified";
  flag?: string | null;
  confidence?: number;
  detected?: string[];
  missing?: string[];
  unexpected?: string[];
  notes?: string | null;
  provider?: string | null;
  unverifiedReason?: string | null;
  evidence?: { url?: string | null; publicId?: string | null };
  image?: { url?: string | null };
  deduped?: boolean;
}

async function callVerification(
  path: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; verdict: VerificationVerdict | null }> {
  const base = process.env.AI_VERIFICATION_URL ?? "";
  const response = await fetch(`${base}/api/verification/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-key": process.env.INTERNAL_SERVICE_KEY ?? "",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(VERIFICATION_TIMEOUT_MS),
  });
  if (!response.ok) {
    return { ok: false, status: response.status, verdict: null };
  }
  return { ok: true, status: response.status, verdict: (await response.json()) as VerificationVerdict };
}

// ─── POST /api/order/verification/:orderId/packing ───────────
// Auth: seller (owner). Body: { image: string } (data URI)
export const submitPackingVerification = tryCatch(async (req: AuthRequest, res) => {
  const user = req.user;
  if (!user) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const orderId = String(req.params?.orderId ?? "");
  const { image } = req.body ?? {};

  if (!orderId) {
    return res.status(400).json({ message: "Order ID is required" });
  }
  if (typeof image !== "string" || image.length === 0) {
    return res.status(400).json({ message: "Packing photo is required" });
  }
  if (image.length > MAX_IMAGE_BASE64_CHARS) {
    return res.status(413).json({ message: "Packing photo too large (max ~10MB)" });
  }

  const order = await getOrderById(orderId);
  if (!order) {
    return res.status(404).json({ message: "No order found" });
  }

  const restaurant = await getRestaurantById(order.restaurantId);
  if (!restaurant) {
    return res.status(404).json({ message: "No restaurant found" });
  }
  if (restaurant.ownerId !== String(user.id)) {
    return res.status(403).json({ message: "Unauthorized" });
  }

  // Gate applies while the bag is still in the kitchen
  if (!gateStatuses.includes(order.status)) {
    return res.status(409).json({
      message: `Packing verification not allowed for status "${order.status}"`,
    });
  }

  const expected = order.items.map((item) => ({
    name: item.name,
    quantity: Number(
      (item as unknown as { quantity?: number; quauntity?: number }).quantity ?? 1,
    ),
  }));

  let verdict: VerificationVerdict | null;
  try {
    const response = await callVerification("packing", {
      orderId,
      restaurantId: restaurant.id,
      expected,
      image,
    });
    verdict = response.verdict;
  } catch (err) {
    console.error(
      "Verification service unreachable:",
      err instanceof Error ? err.message : err,
    );
    return res.status(502).json({
      message: "Verification service unreachable — try again",
    });
  }

  if (!verdict || typeof verdict.status !== "string") {
    return res.status(502).json({
      message: "Verification service unavailable — try again",
    });
  }

  // Persist the denormalized verdict on the order. Idempotent re-checks
  // in the verification service may return the same verdict — last
  // write wins, which is correct: a re-shoot after repacking overwrites
  // the earlier flag.
  const updated = await setPackingVerification(orderId, {
    status: verdict.status,
    flag: verdict.flag ?? null,
    confidence: verdict.confidence ?? 0,
    missing: Array.isArray(verdict.missing) ? verdict.missing : [],
    evidenceUrl: verdict.evidence?.url ?? verdict.image?.url ?? null,
  });

  return res.status(200).json({
    success: true,
    verification: {
      status: verdict.status,
      flag: verdict.flag ?? null,
      confidence: verdict.confidence ?? 0,
      detected: verdict.detected ?? [],
      missing: verdict.missing ?? [],
      unexpected: verdict.unexpected ?? [],
      notes: verdict.notes ?? null,
      provider: verdict.provider ?? null,
      unverifiedReason: verdict.unverifiedReason ?? null,
      evidenceUrl: verdict.evidence?.url ?? null,
      deduped: Boolean(verdict.deduped),
    },
    packingVerification: updated?.packingVerification ?? null,
  });
});

// ─── PUT /api/order/verification/:orderId/override ───────────
// Auth: seller (owner). Body: { note: string } (required, min length).
// Only meaningful on a flagged/unverified order — the explicit
// "ship anyway" action with a mandatory audit note.
export const overridePackingVerification = tryCatch(async (req: AuthRequest, res) => {
  const user = req.user;
  if (!user) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const orderId = String(req.params?.orderId ?? "");
  const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";

  if (!orderId) {
    return res.status(400).json({ message: "Order ID is required" });
  }
  if (note.length < 3) {
    return res.status(400).json({
      message: "An override note (min 3 chars) is required for the audit trail",
    });
  }

  const order = await getOrderById(orderId);
  if (!order) {
    return res.status(404).json({ message: "No order found" });
  }

  const restaurant = await getRestaurantById(order.restaurantId);
  if (!restaurant || restaurant.ownerId !== String(user.id)) {
    return res.status(403).json({ message: "Unauthorized" });
  }

  if (!order.packingVerification || order.packingVerification.status === "verified") {
    return res.status(409).json({ message: "No pending verification flag to override" });
  }

  const updated = await setPackingVerificationOverride(orderId, {
    byUserId: String(user.id),
    note: note.slice(0, 500),
  });
  if (!updated) {
    return res.status(409).json({ message: "No pending verification flag to override" });
  }

  return res.status(200).json({
    success: true,
    message: "Override recorded",
    packingVerification: updated,
  });
});

// ─── GET /api/order/verification/:orderId ────────────────────
// Auth: seller (owner). Current verification state for the kitchen UI.
export const getPackingVerification = tryCatch(async (req: AuthRequest, res) => {
  const user = req.user;
  if (!user) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const orderId = String(req.params?.orderId ?? "");
  if (!orderId) {
    return res.status(400).json({ message: "Order ID is required" });
  }

  const order = await getOrderById(orderId);
  if (!order) {
    return res.status(404).json({ message: "No order found" });
  }

  const restaurant = await getRestaurantById(order.restaurantId);
  if (!restaurant || restaurant.ownerId !== String(user.id)) {
    return res.status(403).json({ message: "Unauthorized" });
  }

  return res.status(200).json({
    success: true,
    verification: order.packingVerification ?? null,
    orderStatus: order.status,
  });
});

// ─── Ready-for-rider gate (shared helper) ────────────────────
// Called before publishing the ready event. Returns an error message
// string when the transition must be blocked, or null to proceed.
export const checkReadyGate = (order: DynamoOrder): string | null => {
  const pv = order.packingVerification;
  if (!pv) return null; // feature never used on this order — no gate

  if (pv.status === "flagged" && !pv.override) {
    const missing = pv.missing?.length ? ` Missing: ${pv.missing.join(", ")}.` : "";
    return `Visual verification flagged this order (${pv.flag ?? "unknown"}). Repack and re-verify, or record an override with a note.${missing}`;
  }

  if (pv.status === "unverified" && !pv.override) {
    return "Visual verification is currently unavailable (AI tier down). Repack, re-verify, or record an override with a note to proceed.";
  }

  return null;
};

