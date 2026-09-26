import crypto from "crypto";
import bcrypt from "bcrypt";
import mongoose, { Schema, model, type Document, type Model } from "mongoose";

// ─── User model (shared) ─────────────────────────────────────
// Owner: auth-service. Admin reads users through the shared schema.
//
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
  refreshTokens: mongoose.Types.DocumentArray<IRefreshToken>;
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

// Reuse an existing registration (hot-reload / multi-entry bundles)
// before defining through the shared schema — mongoose throws
// OverwriteModelError on a second registration of the same name.
export const User: Model<IUser> =
  (mongoose.models.User as Model<IUser> | undefined) ??
  model<IUser>("User", userSchema);
