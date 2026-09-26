import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

// ─── Minimal JWT claims (issued by lib/tokens.ts) ───────────
// Only `sub` + `role` — name/email/profile stay in the DB and come
// from /me. Smaller cookie, smaller tamper surface, no PII in the
// token payload.
export interface AccessClaims {
  sub: string;
  role: string;
  typ: "access";
  iat?: number;
  exp?: number;
}

export interface AuthRequest extends Request {
  user?: AccessClaims;
  // req.session comes from cookie-session's global type augmentation
  // (CookieSessionObject | null | undefined, index-signature so `jwt`
  // is assignable); req.cookies comes from cookie-parser.
}

export const isAuth = (req: AuthRequest, res: Response, next: NextFunction) => {
  const jwtToken = req.session?.jwt;
  if (!jwtToken) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  try {
    const decode = jwt.verify(jwtToken, process.env.JWT_SECRET!) as
      | AccessClaims
      | null
      | undefined;

    // Reject legacy full-user tokens and any non-access typ
    if (!decode || decode.typ !== "access" || !decode.sub) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    req.user = decode;
  } catch (err) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
};
