import { Router, type Request, type RequestHandler, type Response } from "express";
import rateLimit from "express-rate-limit";
import { tryCatch } from "../middlewares/trycatch.js";
import { isAuth, type AuthRequest } from "../middlewares/isAuth.js";
import { isInternal } from "../middlewares/isInternal.js";

// Express 5's strict handler typing rejects AuthRequest-parameter
// middlewares directly; wrap once with an explicit RequestHandler.
const sessionAuth: RequestHandler = (req, res, next) =>
  isAuth(req as AuthRequest, res, next);
import {
  createDirectUploadSignature,
  buildEnhancedUrl,
  buildBeforeUrl,
  buildThumbnailUrl,
  ensureUploadPreset,
  SURFACE_STYLES,
  type SurfaceStyle,
} from "../services/photoEnhancement.js";

// ─── Rate limits ─────────────────────────────────────────────
// Signing is cheap but auth-gated; preview is read-only URL math. A
// tight per-IP window keeps the signing endpoint from being scripted.
const signLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.headers["x-forwarded-for"] as string) || req.ip || "unknown",
});

const router = Router();

// ─── GET /api/utils/photo/styles ─────────────────────────────
// Surface-style catalog for the seller UI's style picker.
router.get("/photo/styles", (_req, res) => {
  res.json({ success: true, styles: SURFACE_STYLES });
});

// ─── POST /api/utils/photo/sign ──────────────────────────────
// Seller-authenticated signed direct upload. The browser uploads the
// FILE itself straight to Cloudinary with this signature — Foodo
// servers never receive the image bytes.
router.post(
  "/photo/sign",
  signLimiter,
  sessionAuth,
  tryCatch(async (req, res) => {
    const user = (req as AuthRequest).user;
    if (!user) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // Scope the folder to the seller so cleanup/audit stays per-partner.
    const folder = `foodo/dishes/${user._id ?? user.sub ?? "unknown"}`;
    const signature = createDirectUploadSignature(folder);

    return res.json({ success: true, ...signature });
  }),
);

// ─── POST /api/utils/photo/preview ───────────────────────────
// Session-authenticated: builds before/after/thumbnail URLs for a
// publicId returned by Cloudinary's direct-upload response. Pure URL
// math — no Cloudinary API call, no cost, no latency.
router.post(
  "/photo/preview",
  sessionAuth,
  tryCatch(async (req, res) => {
    const { publicId, surface } = (req.body ?? {}) as { publicId?: unknown; surface?: unknown };

    if (typeof publicId !== "string" || publicId.length === 0 || publicId.length > 200) {
      return res.status(400).json({ message: "publicId is required" });
    }

    const surfaceStyle: SurfaceStyle =
      typeof surface === "string" && SURFACE_STYLES.includes(surface as SurfaceStyle)
        ? (surface as SurfaceStyle)
        : "marble";

    try {
      return res.json({
        success: true,
        before: buildBeforeUrl(publicId),
        after: buildEnhancedUrl(publicId, surfaceStyle),
        thumbnail: buildThumbnailUrl(publicId),
        surface: surfaceStyle,
        styles: SURFACE_STYLES,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Invalid preview request";
      return res.status(400).json({ message });
    }
  }),
);

// ─── POST /api/utils/photo/preset ────────────────────────────
// Internal-key protected: idempotently ensures the unsigned upload
// preset exists (called once at deploy time by ops tooling).
router.post(
  "/photo/preset",
  isInternal,
  tryCatch(async (_req: Request, res: Response) => {
    const name = await ensureUploadPreset();
    return res.json({ success: true, preset: name });
  }),
);

export { router as photoRouter };
