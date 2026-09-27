import jwt from "jsonwebtoken";

// ─── Central JWT request authorizer (HTTP API v2) ────────────
// Invoked by the shared API Gateway before any protected route's
// Lambda runs. Verifies the app's own HS256 access tokens and
// returns the simple-response format ({ isAuthorized, context })
// because the authorizer resource sets EnableSimpleResponses.
//
// Token transport — checked in order:
//   1. `session` cookie (cookie-session): base64(JSON) containing
//      the JWT. This is the web app's ONLY mechanism today (axios
//      withCredentials). The inner JWT — not the cookie signature —
//      is the cryptographic boundary, so verifying the JWT alone is
//      sound; cookie-session still validates its signature in-app.
//   2. `Authorization: Bearer <jwt>` — for non-browser clients.
//
// Scope: authentication only. Role checks stay in each service
// (isSeller/isRider/isAdmin) — the authorizer must stay in sync
// with backend-common's permissive isAuth, which accepts any valid
// token regardless of `typ`.

interface AuthorizerEvent {
  /** HTTP API v2 puts cookies here when present. */
  cookies?: string[];
  headers?: Record<string, string | undefined>;
}

interface SimpleAuthorizerResult {
  isAuthorized: boolean;
  context?: Record<string, string | number | boolean>;
}

const extractToken = (event: AuthorizerEvent): string | undefined => {
  const cookieHeader =
    event.headers?.Cookie ??
    event.headers?.cookie ??
    (event.cookies ?? []).join("; ");

  const sessionCookie = cookieHeader
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("session="));

  if (sessionCookie) {
    try {
      const raw = decodeURIComponent(sessionCookie.slice("session=".length));
      const session = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
      if (typeof session?.jwt === "string" && session.jwt.length > 0) {
        return session.jwt;
      }
    } catch {
      // malformed cookie — fall through to Authorization header
    }
  }

  const auth = event.headers?.Authorization ?? event.headers?.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  return undefined;
};

export const handler = async (
  event: AuthorizerEvent,
): Promise<SimpleAuthorizerResult> => {
  const token = extractToken(event);
  if (!token) return { isAuthorized: false };

  try {
    const claims = jwt.verify(token, process.env.JWT_SECRET!) as {
      sub?: string;
      role?: string;
    };

    if (!claims?.sub) return { isAuthorized: false };

    // Context values must be scalar (string | number | boolean).
    return {
      isAuthorized: true,
      context: {
        sub: String(claims.sub),
        ...(claims.role !== undefined ? { role: String(claims.role) } : {}),
      },
    };
  } catch {
    return { isAuthorized: false };
  }
};
