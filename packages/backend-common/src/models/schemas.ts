import crypto from "crypto";
import bcrypt from "bcrypt";
import mongoose, { Schema, Types, model, type Document, type Model } from "mongoose";
import type {
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from "@foodo/types";

// ─── Shared Mongoose schemas (@foodo/backend-common/models) ──
// Single source of truth for the collections that cross service
// boundaries (admin now reads them directly). Each owning service
// re-exports its model from here so schema, indexes and the typed
// interface can't drift between services.
//
// Registration: mongoose throws OverwriteModelError when the same
// model name is defined twice in one process. The accessors at the
// bottom reuse an existing registration (hot-reload / multi-entry
// bundles) and otherwise register the shared schema exactly once.

// ─── User ─────────────────────────────────────────────────────
// NOTE: refreshTokens is an embedded array, NOT a separate
// collection. Never put a TTL index on `refreshTokens.expiresAt`:
// Mongo TTL indexes delete the WHOLE parent document, which would
// erase the user. Expired rows are pruned with $pull on access and
// on grant (see pruneExpiredRefreshTokens in auth controllers).

export interface IRefreshToken {
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedByHash: string | null;
}

export interface IUser extends Document {
  name: string;
  email: string;
  password: string;
  role: string;
  image: string;
  refreshTokens: Types.DocumentArray<IRefreshToken>;
  createdAt?: Date;
}

export const userSchema = new Schema<IUser>(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    // select:false — credentials never ride along on normal queries;
    // login explicitly .select("+password"). bcrypt hash stays out of
    // JSON responses, /me payloads and internal admin listing.
    password: { type: String, required: true, select: false },
    role: { type: String, required: true },
    image: { type: String },
    // ─── Refresh-token sessions (server-side revocation) ────────
    // Raw tokens exist only in memory + the user's httpOnly cookie;
    // the DB stores SHA-256 hashes, so a DB leak yields nothing usable.
    // Each grant is a row: revoke one (logout/compromise) or all (ban).
    refreshTokens: [
      {
        tokenHash: { type: String, required: true },
        createdAt: { type: Date, default: Date.now },
        expiresAt: { type: Date, required: true },
        revokedAt: { type: Date, default: null },
        replacedByHash: { type: String, default: null },
      },
    ],
  },
  { timestamps: true },
);

// Fast lookup of a user by refresh-token hash (hashed tokens are keyed).
userSchema.index({ "refreshTokens.tokenHash": 1 });

userSchema.pre("save", async function () {
  if (!this.isModified("password")) {
    return;
  }
  this.password = await bcrypt.hash(this.password, 10);
});

// ─── Refresh-token helpers ──────────────────────────────────
const sha256 = (value: string) =>
  crypto.createHash("sha256").update(value).digest("hex");

export const hashRefreshToken = (raw: string) => sha256(raw);

// 384 bits of entropy — nothing guessable, nothing short.
export const newRefreshTokenRaw = () => crypto.randomBytes(48).toString("hex");

export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ─── Rider ────────────────────────────────────────────────────
export interface IRider extends Document {
  userId: string;
  picture: string;
  phoneNumber: string;
  addharNumber: string;
  drivingLicenseNumber: string;
  isVerified: boolean;
  location: {
    type: "Point";
    coordinates: [number, number];
  };
  isAvailable: boolean;
  lastActive: Date;

  // Saga claim marker — set atomically in the same findOneAndUpdate that
  // flips isAvailable:true→false in acceptOrder. Every release path is a
  // conditional update keyed on this value ("free me ONLY if I'm still
  // holding order X"), so a stale compensation can never free a rider who
  // already claimed a different order.
  currentOrderId: string | null;
}

export const riderSchema = new Schema<IRider>(
  {
    userId: { type: String, required: true, unique: true },
    picture: { type: String, required: true },
    phoneNumber: { type: String, required: true, unique: true },
    addharNumber: { type: String, required: true, unique: true },
    drivingLicenseNumber: { type: String, required: true, unique: true },
    isVerified: { type: Boolean, default: false },
    location: {
      type: { type: String, enum: ["Point"], default: "Point" },
      coordinates: { type: [Number], required: true },
    },
    isAvailable: { type: Boolean, default: false },
    lastActive: { type: Date, default: Date.now },
    currentOrderId: { type: String, default: null },
  },
  {
    timestamps: true,
  },
);

riderSchema.index({ location: "2dsphere" });

// ─── Restaurant ───────────────────────────────────────────────
export interface IRestaurant extends Document {
  name: string;
  description: string;
  image: string;
  ownerId: string;
  phone: number;
  isVerified: boolean;

  autoLocation: {
    type: "Point";
    coordinates: [number, number];
    formattedAddress: string;
  };
  isOpen: boolean;
}

export const restaurantSchema = new Schema<IRestaurant>(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String },
    image: { type: String },
    ownerId: { type: String, required: true },
    phone: { type: Number, required: true },
    isVerified: { type: Boolean, default: false },
    autoLocation: {
      type: { type: String, enum: ["Point"], required: true },
      coordinates: { type: [Number], required: true },
      formattedAddress: { type: String, required: true },
    },
    isOpen: { type: Boolean, default: false },
  },
  {
    timestamps: true,
  },
);

restaurantSchema.index({ autoLocation: "2dsphere" });

// ─── Order ────────────────────────────────────────────────────
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

  status: OrderStatus;

  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;

  // Payment initiation bookkeeping (set via the internal claim endpoint).
  // Enables idempotent re-issue of the SAME provider intent on client
  // retries, plus provider reconciliation for missed webhooks.
  paymentIntent?: {
    provider: "razorpay" | "stripe";
    providerOrderId?: string;
    initiatedAt?: Date;
  };

  expiresAt: Date;

  // Populated by the schema's `timestamps: true`
  createdAt?: Date;
  updatedAt?: Date;
}

export const orderSchema = new Schema<IOrder>(
  {
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
      default: "placed",
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
      index: { expireAfterSeconds: 0 },
    },

    paymentIntent: {
      provider: { type: String, enum: ["razorpay", "stripe"] },
      providerOrderId: { type: String },
      initiatedAt: { type: Date },
    },
  },
  {
    timestamps: true,
  },
);

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

// ─── Model registration ──────────────────────────────────────
// mongoose.model() throws OverwriteModelError if a model name is
// registered twice in one process (tsx --watch, multi-entry bundles).
// Reuse any existing registration before defining through the shared
// schema, so every consumer ends up on the exact same schema object.

function register<T>(
  name: string,
  schema: Schema<T>,
): Model<T> {
  return (
    (mongoose.models[name] as Model<T> | undefined) ?? model<T>(name, schema)
  );
}

export const User = register<IUser>("User", userSchema);
export const Rider = register<IRider>("Rider", riderSchema);
export const Restaurant = register<IRestaurant>("Restaurant", restaurantSchema);
export const Order = register<IOrder>("Order", orderSchema);
