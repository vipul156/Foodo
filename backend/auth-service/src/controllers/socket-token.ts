import type { Response } from "express";
import { tryCatch } from "../middlewares/trycatch.js";
import { signAccessToken } from "../lib/tokens.js";
import type { AuthRequest, AccessClaims } from "../middlewares/isAuth.js";

// ─── Socket bootstrap token ──────────────────────────────────
// Socket.IO connects cross-origin (directly to the realtime service),
// so it can't rely on cookies — it authenticates with a JWT passed in
// handshake.auth.token. That token used to be returned in the login
// body and stashed in sessionStorage, which put a long-lived JWT
// within reach of any XSS. Now the browser fetches it here on demand
// (authenticated by the session cookie) and keeps it in memory only.
export const getSocketToken = tryCatch(
  async (req: AuthRequest, res: Response) => {
    const claims = req.user as AccessClaims;
    return res.status(200).json({
      message: "Socket token issued",
      token: signAccessToken(claims.sub, claims.role),
      expiresIn: 15 * 60, // seconds — matches ACCESS_TTL_SEC
    });
  },
);
