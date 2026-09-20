import type { Response, CookieOptions } from "express";
import jwt from "jsonwebtoken";
import {
  newRefreshTokenRaw,
  hashRefreshToken,
  REFRESH_TTL_MS,
} from "../models/User.js";

// ─── Access token (JWT) ─────────────────────────────────────
// Minimal claims only: `sub` + `role`. Name/email/profile live in the
// database and are fetched on /me — they change, and every byte in the
// cookie JWT is tamper surface + transport cost.
export interface AccessClaims {
  sub: string;
  role: string;
  typ: "access";
}

export const ACCESS_TTL_SEC = 15 * 60; // 15 minutes

export function signAccessToken(sub: string, role: string): string {
  const payload = { role, typ: "access" as const };
  return jwt.sign(payload, process.env.JWT_SECRET!, {
    subject: sub,
    expiresIn: ACCESS_TTL_SEC,
  });
}

// ─── Refresh token (opaque, revocable, hashed at rest) ──────
// Opaque random string, NOT a JWT: the server-side row in the user's
// refreshTokens array is the source of truth, so any session can be
// revoked server-side. JWTs can't be revoked, which is exactly why
// access tokens stay short-lived.
export type IssuedRefresh = { raw: string; tokenHash: string; expiresAt: Date };

export function issueRefreshToken(): IssuedRefresh {
  const raw = newRefreshTokenRaw();
  return {
    raw,
    tokenHash: hashRefreshToken(raw),
    expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
  };
}

export function refreshCookieName(): string {
  return process.env.REFRESH_COOKIE_NAME || "refresh_token";
}

const isProd = () => process.env.NODE_ENV === "production";

export function refreshCookieOptions(): CookieOptions {
  return {
    httpOnly: true, // invisible to JS — XSS cannot exfiltrate it
    secure: isProd(), // HTTPS only in production
    sameSite: "lax", // CSRF-safe for top-level navigations
    path: "/api/auth", // only ever sent to auth endpoints, never /api/*
    maxAge: REFRESH_TTL_MS,
  };
}

// ─── Hardened cookieSession options for THIS service ────────
// The session cookie carries ONLY the short-lived access token (small,
// stable size). Sibling services keep reading req.session.jwt, so
// cookie-session stays as the transport — but the token it carries now
// expires in 15 minutes and revocability comes from server-side refresh
// state, not from the cookie. Tokens are minted by controllers, which
// assign req.session = { jwt } directly (cookie-session reads req.session
// to serialize the Set-Cookie header).
// Sibling services keep their existing cookieSession config; the
// issuing service sets the security flags on cookies it minted.
export function cookieSessionOptions() {
  return {
    name: "session",
    keys: [process.env.COOKIE_SECRET!],
    maxAge: ACCESS_TTL_SEC * 1000,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isProd(),
  };
}
