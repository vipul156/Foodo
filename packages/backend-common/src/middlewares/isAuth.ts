import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

// ─── Unified permissive JWT middleware ───────────────────────
// Union of the permissive `isAuth` variants that ship in restaurant-,
// rider-, admin-, and utils-service. Runtime semantics preserved exactly:
//   1. reads `req.session.jwt` (cookie-session transport),
//   2. unwraps a nested `{ user: {...} }` payload (legacy re-signed JWTs),
//   3. normalizes `sub` / `id` / `_id` across token generations.
//
// auth-service intentionally ships a STRICTER variant that REJECTS legacy
// tokens (checks typ === "access"). Do not merge them; that copy stays in
// auth-service middlewares/isAuth.ts.

/**
 * Session payload shape carried by cookie-session (`req.session`).
 * Mirrors @types/cookie-session's index-signature augmentation.
 */
export interface SessionLike {
  jwt?: string;
  [key: string]: any;
}

/**
 * Authenticated request type shared by the permissive services.
 * `user` stays loosely typed (jwt.JwtPayload-compatible) because legacy
 * tokens may carry arbitrary extra claims.
 */
export interface AuthRequest extends Request {
  user?: jwt.JwtPayload;
  // `| undefined` is required under exactOptionalPropertyTypes to stay
  // assignable from express's Request (whose session includes undefined).
  session?: SessionLike | null | undefined;
}

export const isAuth = (req: AuthRequest, res: Response, next: NextFunction) => {
  const jwtToken = req.session?.jwt;
  if (!jwtToken) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  try {
    let payload = jwt.verify(jwtToken, process.env.JWT_SECRET!) as any;

    // Handle nested user object format: { user: { id, email, role, restaurantId } }
    // This happens when getMyRestaurant re-signs the JWT with a nested user.
    if (payload.user) {
      payload = payload.user;
    }

    // Normalize user ID across token formats:
    //   - auth service (current): minimal claims { sub, role }
    //   - legacy: { id, ... } or { _id, ... }
    if (payload.sub && !payload._id) {
      payload._id = payload.sub;
    }
    if (payload.id && !payload._id) {
      payload._id = payload.id;
    }
    if (payload._id && !payload.id) {
      payload.id = payload._id;
    }

    req.user = payload;
  } catch (err) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
};

// ─── Role guards ─────────────────────────────────────────────
// Semantics preserved VERBATIM from the services, including the quirk that
// isSeller/isAdmin let an UNAUTHENTICATED request pass when `req.user` is
// unset (falsy guard) — only a present user with the wrong role is rejected.
// isRider is the inverse: a missing user is rejected.

export const isSeller = (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  const user = req.user;
  if (user && user.role !== "seller") {
    return res.status(401).json({
      message: "You are not authorized seller",
    });
  }
  next();
};

export const isRider = (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  const user = req.user;
  if (!user || user.role !== "rider") {
    return res.status(401).json({
      message: "You are not authorized rider",
    });
  }
  next();
};

export const isAdmin = (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  const user = req.user;
  if (user && user.role !== "admin") {
    return res.status(401).json({
      message: "You are not authorized",
    });
  }
  next();
};
