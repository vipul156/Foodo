import { Request, Response, NextFunction } from "express";
import crypto from "crypto";

// ─── Internal service auth (fail-closed) ─────────────────────
// Service-to-service calls authenticate with the `x-internal-key`
// header matching INTERNAL_SERVICE_KEY. The comparison is
// constant-time so response timing can't leak the key byte-by-byte.
//
// This is the AI tier's only auth surface: the arbiter and the
// verification service are called by the restaurant/rider/admin
// services (which hold the human's session server-side) — the
// browser never talks to them directly. An unset
// INTERNAL_SERVICE_KEY rejects every request rather than opening
// the door.
//
// The admin/agent review queue uses the same contract, so the
// middleware is shared instead of copied per service.

export const isInternal = (req: Request, res: Response, next: NextFunction) => {
  const provided = req.headers["x-internal-key"];
  const expected = process.env.INTERNAL_SERVICE_KEY ?? "";

  if (
    typeof provided !== "string" ||
    expected.length === 0 ||
    provided.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
  ) {
    return res.status(403).json({ message: "Forbidden" });
  }
  next();
};
