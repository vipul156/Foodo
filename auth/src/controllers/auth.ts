import type { Response } from "express";
import { User } from "../models/User.js";
import { tryCatch } from "../middlewares/trycatch.js";
import bcrypt from "bcrypt";
import {
  signAccessToken,
  issueRefreshToken,
  refreshCookieName,
  refreshCookieOptions,
  type IssuedRefresh,
} from "../lib/tokens.js";
import { hashRefreshToken } from "../models/User.js";
import type { AuthRequest, AccessClaims } from "../middlewares/isAuth.js";

const allowedRoles = ["customer", "rider", "seller"] as const;

// ─── Refresh-row pruning ────────────────────────────────────
// refreshTokens is embedded, so Mongo TTL indexes are off the table
// (a TTL index on an array field deletes the whole parent user doc).
// Expired rows are pruned opportunistically on every session issue.
async function pruneExpiredRefreshTokens(userId: string): Promise<void> {
  await User.updateOne(
    { _id: userId },
    { $pull: { refreshTokens: { expiresAt: { $lte: new Date() } } } },
  );
}

// ─── Shared issue logic: register + login ───────────────────
// 1. Prune expired rows (keeps the embedded array from growing).
// 2. Push a fresh refresh-token row (hash only — raw token never stored).
// 3. Transport: access JWT in the session cookie (sibling services keep
//    reading req.session.jwt), refresh raw token in its own httpOnly
//    cookie scoped to /api/auth.
async function issueSession(
  res: Response,
  user: { _id: string; role: string },
): Promise<string> {
  await pruneExpiredRefreshTokens(user._id);

  const refresh = issueRefreshToken();
  await User.updateOne(
    { _id: user._id },
    {
      $push: {
        refreshTokens: {
          tokenHash: refresh.tokenHash,
          expiresAt: refresh.expiresAt,
        },
      },
    },
  );

  // NOTE: this helper only persists the refresh row and sets the refresh
  // cookie. The access JWT goes into the cookie-session, which lives on
  // req.session — callers must set req.session = { jwt: accessJwt }.
  const accessJwt = signAccessToken(String(user._id), user.role);
  res.cookie(refreshCookieName(), refresh.raw, refreshCookieOptions());
  return accessJwt;
}

function publicUser(user: {
  _id: unknown;
  name: string;
  email: string;
  role: string;
  image: string;
}) {
  return {
    _id: String(user._id),
    name: user.name,
    email: user.email,
    role: user.role,
    image: user.image,
  };
}

// ─── Register ────────────────────────────────────────────────

export const registerUser = tryCatch(async (req, res) => {
  const { name, email, password, role, image } = req.body;
  if (!allowedRoles.includes(role))
    return res.status(400).json({ message: "Invalid role" });

  const existing = await User.findOne({ email });
  if (existing) {
    return res.status(400).json({ message: "User already exists" });
  }

  const user = await User.create({ name, email, password, role, image });
  const accessJwt = await issueSession(res, {
    _id: String(user._id),
    role: user.role,
  });
  req.session = { jwt: accessJwt };

  return res.status(201).json({
    message: "User created successfully",
    user: publicUser(user),
  });
});

// ─── Login ───────────────────────────────────────────────────

export const loginUser = tryCatch(async (req, res) => {
  const { email, password } = req.body;

  // password is select:false — request it explicitly for the compare
  const user = await User.findOne({ email }).select("+password");
  if (!user) {
    return res.status(400).json({ message: "User not found" });
  }
  const isPasswordValid = await bcrypt.compare(password, user.password);
  if (!isPasswordValid) {
    return res.status(400).json({ message: "Invalid password" });
  }

  const accessJwt = await issueSession(res, {
    _id: String(user._id),
    role: user.role,
  });
  req.session = { jwt: accessJwt };

  return res.status(200).json({
    message: "User logged in successfully",
    user: publicUser(user),
  });
});

// ─── Refresh (rotation + reuse detection) ───────────────────
// The client calls this when its access token expires (401 retry).
// The presented refresh token is single-use: revoked and replaced.
// If an already-revoked token shows up again, that's a replay of a
// stolen token — every active session of the user is revoked.
export const refreshUser = tryCatch(async (req: AuthRequest, res) => {
  const presented = req.cookies?.[refreshCookieName()];
  if (!presented) {
    return res
      .status(401)
      .json({ message: "No refresh token; please log in again" });
  }

  const presentedHash = hashRefreshToken(presented);
  const user = await User.findOne({ "refreshTokens.tokenHash": presentedHash });
  const row = user?.refreshTokens.find((t) => t.tokenHash === presentedHash);
  if (!user || !row) {
    return res
      .status(401)
      .json({ message: "Invalid refresh token; please log in again" });
  }

  // Reuse detection: a revoked token must never come back. Burn the
  // whole family so the thief and the legitimate client both stop here.
  if (row.revokedAt) {
    await User.updateOne(
      { _id: user._id },
      { $set: { "refreshTokens.$[t].revokedAt": new Date() } },
      { arrayFilters: [{ "t.revokedAt": null }] },
    );
    req.session = null;
    res.clearCookie(refreshCookieName(), refreshCookieOptions());
    return res.status(401).json({
      message: "Session revoked (token reuse detected); please log in again",
    });
  }

  if (row.expiresAt.getTime() <= Date.now()) {
    return res
      .status(401)
      .json({ message: "Refresh token expired; please log in again" });
  }

  // Single-use rotation: revoke the presented row, link it to the next
  // generation (enables chain walks / family audits), mint the new pair.
  const next: IssuedRefresh = issueRefreshToken();
  await User.updateOne(
    { _id: user._id, "refreshTokens.tokenHash": presentedHash },
    {
      $set: {
        "refreshTokens.$.revokedAt": new Date(),
        "refreshTokens.$.replacedByHash": next.tokenHash,
      },
    },
  );
  await pruneExpiredRefreshTokens(String(user._id));
  await User.updateOne(
    { _id: user._id },
    {
      $push: {
        refreshTokens: {
          tokenHash: next.tokenHash,
          expiresAt: next.expiresAt,
        },
      },
    },
  );

  const accessJwt = signAccessToken(String(user._id), user.role);
  req.session = { jwt: accessJwt };
  res.cookie(refreshCookieName(), next.raw, refreshCookieOptions());

  return res.status(200).json({
    message: "Token refreshed",
    accessToken: accessJwt,
    user: publicUser(user),
  });
});

// ─── Get current user (from DB, not from JWT claims) ─────────
// The JWT is unforgeable but stale by design — roles can change.
// /me is the source of truth for profile data.

export const getUser = tryCatch(async (req: AuthRequest, res) => {
  const claims = req.user as AccessClaims;
  const user = await User.findById(claims.sub).select(
    "-password -refreshTokens",
  );
  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }
  return res
    .status(200)
    .json({ message: "User fetched successfully", user });
});

// ─── Logout (server-side revocation, not just cookie clearing) ──
// Revokes the presented refresh row so it can never be refreshed
// again, then clears both cookies. The access JWT dies naturally in
// ≤ ACCESS_TTL (15 min) — that's the price of stateless verification.
export const logoutUser = tryCatch(async (req: AuthRequest, res) => {
  const presented = req.cookies?.[refreshCookieName()];
  const sub = req.user?.sub;

  if (presented && sub) {
    const presentedHash = hashRefreshToken(presented);
    await User.updateOne(
      { _id: sub, "refreshTokens.tokenHash": presentedHash },
      {
        $set: {
          "refreshTokens.$.revokedAt": new Date(),
        },
      },
    );
  }

  req.session = null;
  res.clearCookie(refreshCookieName(), refreshCookieOptions());
  return res.status(200).json({ message: "Logged out successfully" });
});
