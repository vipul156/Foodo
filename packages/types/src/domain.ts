// ─── Auth ─────────────────────────────────────────────────────
// Roles used across auth-service, guards, and the web app.
export type UserRole = "customer" | "seller" | "rider" | "admin";

// Minimal JWT access-token claims (issued by auth-service lib/tokens.ts).
// Only `sub` + `role` — name/email/profile stay in the DB and come from
// /me. Smaller cookie, smaller tamper surface, no PII in the token payload.
export interface AccessClaims {
  sub: string;
  role: string;
  typ: "access";
  iat?: number;
  exp?: number;
}

// ─── Orders ──────────────────────────────────────────────────
// Canonical lifecycle of an order (restaurant-service Order model,
// web/src/types OrderStatus, and every socket payload).
export type OrderStatus =
  | "placed"
  | "accepted"
  | "preparing"
  | "ready_for_rider"
  | "rider_assigned"
  | "picked_up"
  | "delivered"
  | "cancelled";

export type PaymentMethod = "razorpay" | "stripe" | "cod";

export type PaymentStatus = "pending" | "paid" | "failed";
