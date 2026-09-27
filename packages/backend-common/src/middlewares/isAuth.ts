import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

// ─── Unified permissive JWT middleware ───────────────────────
// JWT VERIFICATION LIVES AT THE API GATEWAY now (the shared REQUEST
// authorizer in the foodo-core-api stack verifies signature + expiry
// before any protected route's Lambda is invoked). This middleware
// therefore only RECONSTRUCTS req.user:
//
//   1. Preferred: the authorizer's verified claims, which arrive on
//      the Lambda event at requestContext.authorizer.lambda (exposed
//      to express via serverless-http's req.apiGateway).
//   2. Fallback: DECODE (not verify) the session JWT. Safe because
//      every route that reaches this middleware sits behind the
//      gateway authorizer.
//
// Union of the permissive `isAuth` variants that ship in restaurant-,
// rider-, admin-, and utils-service. Runtime semantics preserved:
//   - unwraps a nested `{ user: {...} }` payload (legacy re-signed JWTs),
//   - normalizes `sub` / `id` / `_id` across token generations.
//
// auth-service intentionally ships a STRICTER variant that REJECTS
// legacy tokens (checks typ === "access"). Do not merge them; that copy
// stays in auth-service middlewares/isAuth.ts.

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

/** Verified claims injected by the API Gateway request authorizer. */
interface GatewayClaims {
  sub?: string;
  role?: string;
  [key: string]: unknown;
}

const gatewayClaims = (req: Request): GatewayClaims | undefined => {
  // serverless-http exposes the raw API Gateway event on req.apiGateway
  // (v3+: { event, context }; older shapes pass the event itself).
  const gw = (req as any).apiGateway;
  const event = gw?.event ?? gw;
  const claims = event?.requestContext?.authorizer?.lambda;
  return claims?.sub ? (claims as GatewayClaims) : undefined;
};

/** Normalize user ID across token generations (sub / id / _id). */
const normalizeIds = (payload: Record<string, any>): void => {
  if (payload.sub && !payload._id) payload._id = payload.sub;
  if (payload.id && !payload._id) payload._id = payload.id;
  if (payload._id && !payload.id) payload.id = payload._id;
};

export const isAuth = (req: AuthRequest, res: Response, next: NextFunction) => {
  // 1) Gateway-verified claims — no re-verification needed.
  const fromGateway = gatewayClaims(req);
  if (fromGateway) {
    const user: Record<string, any> = { ...fromGateway };
    normalizeIds(user);
    req.user = user as jwt.JwtPayload;
    return next();
  }

  // 2) Fallback: decode the session cookie's JWT. Signature + expiry
  //    were already enforced by the gateway authorizer.
  const jwtToken = req.session?.jwt;
  if (!jwtToken) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  let payload = jwt.decode(jwtToken) as Record<string, any> | null;
  if (!payload) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  // Handle nested user object format: { user: { id, email, role, restaurantId } }
  // This happens when getMyRestaurant re-signs the JWT with a nested user.
  if (payload.user) {
    payload = payload.user as Record<string, any>;
  }

  normalizeIds(payload);
  req.user = payload as jwt.JwtPayload;
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
