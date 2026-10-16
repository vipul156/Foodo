import { AuthRequest } from "../middlewares/isAuth.js";
import { tryCatch } from "../middlewares/trycatch.js";
import { Order } from "../models/Order.js";
import { Restaurant } from "../models/Restaurant.js";
import { verifyViaBreaker } from "../config/verification.http.js";
import { publishRealtimeEvent } from "../config/realtime.publisher.js";

// ─── Packing verification (restaurant service) ───────────────
// The kitchen flow: seller packs → snapshots the open bag → this service
// validates ownership, builds the expected ticket from the ORDER (not
// the client), and proxies to the utils AI tier. The verdict comes back
// synchronously so the kitchen screen can warn BEFORE sealing the bag.
//
// Trust boundaries:
//   - Expected items are read from the stored order document — a client
//     can never claim "expected: 1x item" to launder a short-pack.
//   - The image is a base64 data URI from the browser upload, capped at
//     10MB pre-encode; utils re-validates mime + size independently.

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
  image?: { url?: string | null };
  evidence?: { url?: string | null; publicId?: string | null };
  deduped?: boolean;
}

const MAX_IMAGE_BASE64_CHARS = 14_000_000; // ≈10MB binary

// ─── POST /api/order/verification/:orderId/packing ───────────
// Auth: seller (owner). Body: { image: string } (data URI)

export const submitPackingVerification = tryCatch(
  async (req: AuthRequest, res) => {
    const user = req.user;
    if (!user) throw new Error("Unauthorized");

    const { orderId } = req.params;
    const { image } = req.body ?? {};

    if (!orderId) throw new Error("Order ID is required");
    if (typeof image !== "string" || image.length === 0) {
      throw new Error("Packing photo is required");
    }
    if (image.length > MAX_IMAGE_BASE64_CHARS) {
      return res.status(413).json({ message: "Packing photo too large (max ~10MB)" });
    }

    const order = await Order.findById(orderId);
    if (!order) throw new Error("No order found");

    const restaurant = await Restaurant.findById(order.restaurantId);
    if (!restaurant) throw new Error("No restaurant found");

    // Ownership: the snapshot must come from THIS order's kitchen
    if (restaurant.ownerId.toString() !== user._id.toString()) {
      throw new Error("Unauthorized");
    }

    // Gate applies while the bag is still in the kitchen
    const gateStatuses = ["placed", "accepted", "preparing", "ready_for_rider"];
    if (!gateStatuses.includes(order.status)) {
      throw new Error(`Packing verification not allowed for status "${order.status}"`);
    }

    const expected = order.items.map((item) => ({
      itemId: item.itemId?.toString?.() ?? String(item.itemId),
      name: item.name,
      // NOTE: the Order schema historically misspells quantity as
      // "quauntity" in the interface (the DB field is "quantity") — cast
      // defensively so both shapes work.
      quantity: Number((item as unknown as { quantity?: number }).quantity ?? 1),
    }));

    const verdict = await verifyViaBreaker<VerificationVerdict>(
      `${process.env.UTILS_SERVICE_URL}/api/utils/verification/packing`,
      { orderId: String(order._id), restaurantId: String(restaurant._id), expected, image },
      { headers: { "x-internal-key": process.env.INTERNAL_SERVICE_KEY } },
    );

    // Persist the verdict on the order (idempotent re-checks in utils
    // may return the same verdict — last write wins, which is correct:
    // a re-shoot after repacking overwrites the earlier flag).
    order.packingVerification = {
      status: verdict.status,
      flag: verdict.flag ?? null,
      confidence: verdict.confidence ?? 0,
      missing: Array.isArray(verdict.missing) ? verdict.missing : [],
      override: null,
      verifiedAt: new Date(),
      evidenceUrl: verdict.evidence?.url ?? verdict.image?.url ?? null,
    };
    await order.save();

    // Kitchen screens subscribed to the order room update instantly
    publishRealtimeEvent("order:verification", `order:${order._id}`, {
      orderId: order._id,
      status: verdict.status,
      flag: verdict.flag ?? null,
      missing: verdict.missing ?? [],
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
      order,
    });
  },
);

// ─── PUT /api/order/verification/:orderId/override ───────────
// Auth: seller (owner). Body: { note: string } (required, min length)
// Only meaningful on a flagged/unverified order — the explicit
// "ship anyway" action with a mandatory audit note.

export const overridePackingVerification = tryCatch(
  async (req: AuthRequest, res) => {
    const user = req.user;
    if (!user) throw new Error("Unauthorized");

    const { orderId } = req.params;
    const { note } = req.body ?? {};

    if (!orderId) throw new Error("Order ID is required");
    const trimmed = typeof note === "string" ? note.trim() : "";
    if (trimmed.length < 3) {
      throw new Error("An override note (min 3 chars) is required for the audit trail");
    }

    const order = await Order.findById(orderId);
    if (!order) throw new Error("No order found");

    const restaurant = await Restaurant.findById(order.restaurantId);
    if (!restaurant) throw new Error("No restaurant found");
    if (restaurant.ownerId.toString() !== user._id.toString()) {
      throw new Error("Unauthorized");
    }

    const current = order.packingVerification;
    if (!current || current.status === "verified") {
      throw new Error("No pending verification flag to override");
    }

    current.override = {
      at: new Date(),
      byUserId: user._id.toString(),
      note: trimmed.slice(0, 500),
    };
    await order.save();

    return res.status(200).json({
      success: true,
      message: "Override recorded",
      order,
    });
  },
);

// ─── GET /api/order/verification/:orderId ────────────────────
// Auth: seller (owner). Current verification state for the kitchen UI.

export const getPackingVerification = tryCatch(
  async (req: AuthRequest, res) => {
    const user = req.user;
    if (!user) throw new Error("Unauthorized");

    const { orderId } = req.params;
    if (!orderId) throw new Error("Order ID is required");

    const order = await Order.findById(orderId).select("packingVerification status restaurantId");
    if (!order) throw new Error("No order found");

    const restaurant = await Restaurant.findById(order.restaurantId);
    if (!restaurant || restaurant.ownerId.toString() !== user._id.toString()) {
      throw new Error("Unauthorized");
    }

    return res.status(200).json({
      success: true,
      verification: order.packingVerification ?? null,
      orderStatus: order.status,
    });
  },
);

// ─── Ready-for-rider gate (shared helper) ────────────────────
// Called by updateOrderStatus before publishing the ready event.
// Returns an error message string when the transition must be blocked,
// or null when it may proceed.

export const checkReadyGate = (
  order: {
    packingVerification?: {
      status: string;
      flag?: string | null;
      missing?: string[];
      override?: { at: Date; byUserId: string; note: string } | null;
    } | null;
  },
): string | null => {
  const pv = order.packingVerification;
  if (!pv) return null; // feature never used on this order — no gate

  if (pv.status === "flagged" && !pv.override) {
    const missing = pv.missing?.length
      ? ` Missing: ${pv.missing.join(", ")}.`
      : "";
    return `Visual verification flagged this order (${pv.flag ?? "unknown"}). Repack and re-verify, or record an override with a note.${missing}`;
  }

  if (pv.status === "unverified" && !pv.override) {
    return "Visual verification is currently unavailable (AI tier down). Repack, re-verify, or record an override with a note to proceed.";
  }

  return null;
};
