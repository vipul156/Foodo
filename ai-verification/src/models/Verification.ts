import { Schema, Document, model } from "mongoose";

export interface IVerification extends Document {
  orderId: string;
  type: "packing" | "delivery";

  // Denormalized actor context for audit + dispute lookup (no joins —
  // this collection is read standalone by support tooling)
  restaurantId: string | null;
  riderId: string | null;
  customerId: string | null;

  status: "verified" | "flagged" | "unverified";
  flag: string | null;
  confidence: number;
  detected: string[];
  missing: string[];
  unexpected: string[];
  notes: string | null;

  // Which AI tier produced the verdict (gemini | claude) — or null when
  // the whole AI chain was down (status "unverified")
  provider: string | null;
  unverifiedReason: string | null;

  // Cloudinary evidence copy for dispute resolution. The AI verdict is
  // ephemeral; the photo is the legal record.
  image: {
    url: string | null;
    publicId: string | null;
  };

  expiresAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const verificationSchema = new Schema<IVerification>(
  {
    orderId: { type: String, required: true, index: true },
    type: { type: String, enum: ["packing", "delivery"], required: true },

    restaurantId: { type: String, default: null },
    riderId: { type: String, default: null },
    customerId: { type: String, default: null },

    status: {
      type: String,
      enum: ["verified", "flagged", "unverified"],
      required: true,
    },
    flag: { type: String, default: null },
    confidence: { type: Number, default: 0 },
    detected: { type: [String], default: [] },
    missing: { type: [String], default: [] },
    unexpected: { type: [String], default: [] },
    notes: { type: String, default: null },

    provider: { type: String, default: null },
    unverifiedReason: { type: String, default: null },

    image: {
      url: { type: String, default: null },
      publicId: { type: String, default: null },
    },

    // Evidence retention: photos + verdicts age out (dispute windows are
    // typically 30-90 days). Keeps the collection bounded forever.
    expiresAt: {
      type: Date,
      required: true,
      index: { expireAfterSeconds: 0 },
    },
  },
  { timestamps: true },
);

// Dispute lookup: every verdict for one order, newest first
verificationSchema.index({ orderId: 1, type: 1, createdAt: -1 });
// Fraud sweeps: flagged verdicts by restaurant (repeat-offender kitchens)
verificationSchema.index({ restaurantId: 1, status: 1, createdAt: -1 });
verificationSchema.index({ riderId: 1, status: 1, createdAt: -1 });

export const Verification = model<IVerification>("Verification", verificationSchema);
