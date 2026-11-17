import { Request, Response, NextFunction } from "express";
import crypto from "crypto";

// ─── Internal service auth (fail-closed) ─────────────────────
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
