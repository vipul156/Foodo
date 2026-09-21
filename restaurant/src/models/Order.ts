import { Schema, Document, model, Types } from "mongoose";

export interface IOrder extends Document {
  userId: string;
  restaurantId: string;
  restaurantName: string;
  restaurantLocation?: {
    latitude: number;
    longitude: number;
  };
  riderId?: string | null;
  riderPhone: number | null;
  riderName: string | null;
  riderPicture?: string | null;
  distance: number;
  riderAmount: number;

  items: {
    // ObjectId — matches MenuItem._id so $in lookups cast natively and
    // embeds stay 12 bytes instead of a 24-char hex string.
    itemId: Types.ObjectId;
    name: string;
    price: number;
    quauntity: number;
  }[];

  subtotal: number;
  deliveryFee: number;
  platformFee: number;
  totalAmount: number;

  addressId: string;
  deliveryAddress: {
    formattedAddress: string;
    mobile: number;
    latitude: number;
    longitude: number;
  };

  status:
    | "placed"
    | "accepted"
    | "preparing"
    | "ready_for_rider"
    | "rider_assigned"
    | "picked_up"
    | "delivered"
    | "cancelled";

  paymentMethod: "razorpay" | "stripe" | "cod";
  paymentStatus: "pending" | "paid" | "failed";

  // Payment initiation bookkeeping (set via the internal claim endpoint).
  // Enables idempotent re-issue of the SAME provider intent on client
  // retries, plus provider reconciliation for missed webhooks.
  paymentIntent?: {
    provider: "razorpay" | "stripe";
    providerOrderId?: string;
    initiatedAt?: Date;
  };

  // ─── Visual kitchen verification (AppSec / fraud defense) ──
  // Set by the internal verification endpoint when the seller snapshots
  // the open bag. `packingVerifiedAt` is the gate: marking an order
  // ready_for_rider is BLOCKED while a pending flag exists — the kitchen
  // screen must clear it (repack + re-shoot) or override with a note.
  packingVerification?: {
    status: "verified" | "flagged" | "unverified";
    flag: string | null;
    confidence: number;
    missing: string[];
    // Audit trail: who pressed "ship anyway" and why. Disputes pull
    // this record; absence of an override on a flagged order means the
    // flag was cleared by repacking, never silently skipped.
    override?: {
      at: Date;
      byUserId: string;
      note: string;
    } | null;
    verifiedAt: Date | null;
    evidenceUrl: string | null;
  };

  // ─── Proof of delivery (rider side) ────────────────────────
  // Attached by the internal rider status endpoint when the drop-off
  // photo verdict arrives with the completion call. Advisory dispute
  // evidence: a flagged POD never blocks delivery completion.
  proofOfDelivery?: {
    status: "verified" | "flagged" | "unverified";
    flag: string | null;
    confidence: number;
    notes: string | null;
    evidenceUrl: string | null;
    at: Date;
  };

  expiresAt: Date;

  // Populated by the schema's `timestamps: true`
  createdAt?: Date;
  updatedAt?: Date;
}

const orderSchema = new Schema<IOrder>({
  userId: { type: String, required: true },
  restaurantId: { type: String, required: true },
  restaurantLocation: {
    latitude: { type: Number },
    longitude: { type: Number },
  },
  restaurantName: { type: String, required: true },
  riderId: { type: String, default: null },
  riderName: { type: String, default: null },
  riderPhone: { type: Number, default: null },
  riderAmount: { type: Number, required: true },
  distance: { type: Number, required: true },
  items: [
    {
      itemId: { type: Schema.Types.ObjectId, ref: "MenuItem" },
      name: String,
      price: Number,
      quantity: Number,
    },
  ],

  subtotal: Number,
  deliveryFee: Number,
  platformFee: Number,
  totalAmount: Number,

  addressId: {
    type: String,
    required: true,
  },

  deliveryAddress: {
    formattedAddress: { type: String, required: true },
    mobile: { type: Number, required: true },
    latitude: Number,
    longitude: Number,
  },

  status: {
    type: String,
    enum: [
      "placed",
      "accepted",
      "preparing",
      "ready_for_rider",
      "rider_assigned",
      "picked_up",
      "delivered",
      "cancelled",
    ],
    default: "placed"
  },

  paymentMethod: {
    type: String,
    enum: ["razorpay", "stripe", "cod"],
    required: true,
  },

  paymentStatus: {
    type: String,
    enum: ["pending", "paid", "failed"],
    default: "pending",
  },

  expiresAt: {
    type: Date,
    index: {expireAfterSeconds: 0},
  },

  paymentIntent: {
    provider: { type: String, enum: ["razorpay", "stripe"] },
    providerOrderId: { type: String },
    initiatedAt: { type: Date },
  },

  // Visual kitchen verification (packing gate + override audit)
  packingVerification: {
    status: { type: String, enum: ["verified", "flagged", "unverified"] },
    flag: { type: String, default: null },
    confidence: { type: Number, default: 0 },
    missing: { type: [String], default: [] },
    override: {
      at: { type: Date },
      byUserId: { type: String },
      note: { type: String },
    },
    default: null,
  },

  // Proof of delivery (advisory dispute evidence, rider side)
  proofOfDelivery: {
    status: { type: String, enum: ["verified", "flagged", "unverified"] },
    flag: { type: String, default: null },
    confidence: { type: Number, default: 0 },
    notes: { type: String, default: null },
    evidenceUrl: { type: String, default: null },
    at: { type: Date },
  },
},{
    timestamps: true
});

// ─── Compound indexes (match the real query shapes) ──────────
// Without these, every "my orders", restaurant board and rider history
// read is a full collection scan at scale. Each index follows the
// ESR rule (Equality → Sort → Range) so the sort is satisfied from the
// index itself instead of an in-memory block.

// getMyOrders: find({ userId }).sort({ createdAt: -1 })
orderSchema.index({ userId: 1, createdAt: -1 });

// fetchRestaurantOrders: find({ restaurantId, paymentStatus: "paid" })
//   .sort({ createdAt: -1 }) — equality first, sort last.
orderSchema.index({ restaurantId: 1, paymentStatus: 1, createdAt: -1 });

// Rider history + current delivery:
//   find({ riderId, status: "delivered", paymentStatus: "paid" }) and
//   find({ riderId, status: { $ne: "delivered" } }) — equality on
//   riderId+status, createdAt covers the history sort.
orderSchema.index({ riderId: 1, status: 1, createdAt: -1 });

// Admin analytics: status-only counts (delivered / cancelled / active).
orderSchema.index({ status: 1 });

// getReadyOrdersNearRider: find({ status: "ready_for_rider",
// paymentStatus: "paid" }).sort({ createdAt: 1 })
orderSchema.index({ status: 1, paymentStatus: 1, createdAt: 1 });

export const Order = model<IOrder>("Order", orderSchema);
