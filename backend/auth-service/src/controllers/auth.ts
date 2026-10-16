import type { Response } from "express";
import { tryCatch } from "@foodo/backend-common";
import {
  createUser,
  getUserByEmail,
  getUserById,
  getUserByRefreshTokenHash,
  grantRefreshToken,
  revokeRefreshToken,
  revokeAllActiveRefreshTokens,
  hashRefreshToken,
} from "@foodo/backend-common/dynamo";
import bcrypt from "bcryptjs";
import {
  signAccessToken,
  issueRefreshToken,
  refreshCookieName,
  refreshCookieOptions,
  type IssuedRefresh,
} from "../lib/tokens.js";
import type { AuthRequest, AccessClaims } from "../middlewares/isAuth.js";
import {
  recordAuthFailure,
  clearAuthFailures,
} from "../middlewares/rate-limit.js";

const allowedRoles = ["customer", "rider", "seller"] as const;

// ─── Refresh-row pruning ────────────────────────────────────
// No $pull needed anymore: refresh rows are their own DynamoDB items
// with a `ttl` attribute — DynamoDB sweeps expired rows automatically.
// Expired rows are also rejected on use (expiry check below), so the
// sweep window is invisible to users.

// ─── Shared issue logic: register + login ───────────────────
// 1. Push a fresh refresh-token row (hash only — raw token never stored).
// 2. Transport: access JWT in the session cookie (sibling services keep
//    reading req.session.jwt), refresh raw token in its own httpOnly
//    cookie scoped to /api/auth.
async function issueSession(
  res: Response,
  user: { id: string; role: string },
): Promise<string> {
  const refresh = issueRefreshToken();
  await grantRefreshToken(user.id, refresh.tokenHash, refresh.expiresAt);

  // NOTE: this helper only persists the refresh row and sets the refresh
  // cookie. The access JWT goes into the cookie-session, which lives on
  // req.session — callers must set req.session = { jwt: accessJwt }.
  const accessJwt = signAccessToken(user.id, user.role);
  res.cookie(refreshCookieName(), refresh.raw, refreshCookieOptions());
  return accessJwt;
}

function publicUser(user: {
  id: string;
  name: string;
  email: string;
  role: string;
  image: string;
}) {
  return {
    id: user.id,
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

  const existing = await getUserByEmail(email);
  if (existing) {
    return res.status(400).json({ message: "User already exists" });
  }

  // bcrypt replaces the old pre-save hook (DynamoDB has no schema hooks).
  const user = await createUser({
    name,
    email,
    password: await bcrypt.hash(password, 10),
    role,
    image,
  });
  const accessJwt = await issueSession(res, { id: user.id, role: user.role });
  req.session = { jwt: accessJwt };

  return res.status(201).json({
    message: "User created successfully",
    user: publicUser(user),
  });
});

// ─── Login ───────────────────────────────────────────────────

export const loginUser = tryCatch(async (req, res) => {
  const { email, password } = req.body;

  const user = await getUserByEmail(email);
  if (!user) {
    recordAuthFailure(req);
    return res.status(400).json({ message: "User not found" });
  }
  const isPasswordValid = await bcrypt.compare(password, user.password);
  if (!isPasswordValid) {
    recordAuthFailure(req);
    return res.status(400).json({ message: "Invalid password" });
  }

  clearAuthFailures(req); // success — the failure counter resets

  const accessJwt = await issueSession(res, { id: user.id, role: user.role });
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
  const found = await getUserByRefreshTokenHash(presentedHash);
  if (!found) {
    return res
      .status(401)
      .json({ message: "Invalid refresh token; please log in again" });
  }

  const { user, row } = found;

  // Reuse detection: a revoked token must never come back. Burn the
  // whole family so the thief and the legitimate client both stop here.
  if (row.revokedAt) {
    await revokeAllActiveRefreshTokens(user.id);
    req.session = null;
    res.clearCookie(refreshCookieName(), refreshCookieOptions());
    return res.status(401).json({
      message: "Session revoked (token reuse detected); please log in again",
    });
  }

  if (Date.parse(row.expiresAt) <= Date.now()) {
    return res
      .status(401)
      .json({ message: "Refresh token expired; please log in again" });
  }

  // Single-use rotation: revoke the presented row, link it to the next
  // generation (enables chain walks / family audits), mint the new pair.
  const next: IssuedRefresh = issueRefreshToken();
  await revokeRefreshToken(user.id, presentedHash, next.tokenHash);
  await grantRefreshToken(user.id, next.tokenHash, next.expiresAt);

  const accessJwt = signAccessToken(user.id, user.role);
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
  const user = await getUserById(claims.sub);
  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }

  // Credentials never leave the DB — strip password/refresh state.
  const { password: _password, ...safeUser } = user;

  return res
    .status(200)
    .json({ message: "User fetched successfully", user: safeUser });
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
    await revokeRefreshToken(sub, presentedHash, null).catch(() => {
      // Row already swept (TTL) or unknown — logout is still complete.
    });
  }

  req.session = null;
  res.clearCookie(refreshCookieName(), refreshCookieOptions());
  return res.status(200).json({ message: "Logged out successfully" });
});
