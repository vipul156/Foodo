import { Router } from "express";
import { tryCatch } from "../middlewares/trycatch.js";
import { isInternal } from "../middlewares/isInternal.js";
import uploadFile from "../middlewares/multer.js";
import { v2 } from "cloudinary";

const router = Router();

// ─── POST /api/utils/upload (internal only) ─────────────────
// Server-to-server passthrough for sibling services (rider profile
// photos, restaurant cover images, menu items without an enhanced URL).
//
// HARDENED: previously this endpoint accepted unauthenticated base64
// uploads — an open upload proxy on a payments service. Now internal-key
// gated (fail-closed, constant-time compare). The browser-facing path is
// the photo pipeline's SIGNED DIRECT upload, where bytes go browser →
// Cloudinary and never through this service at all.
//
// Body: JSON { buffer: <data URI> } (legacy internal contract) OR
// multipart/form-data with a `file` field.
router.post("/upload", isInternal, uploadFile, tryCatch(async (req, res) => {
  const body = (req.body ?? {}) as { buffer?: unknown; folder?: unknown };

  // Data-URI JSON path (restaurant/rider services forward base64).
  let payload: string | undefined;
  if (typeof body.buffer === "string" && body.buffer.startsWith("data:")) {
    // Only image MIME types — this endpoint is for images; video/raw
    // uploads have no caller today and expand the attack surface.
    if (!/^data:image\/(jpeg|png|webp);base64,/.test(body.buffer)) {
      return res.status(400).json({ message: "Only jpeg/png/webp images are supported" });
    }
    if (body.buffer.length > 14_000_000) {
      return res.status(413).json({ message: "Image too large (max ~10MB)" });
    }
    payload = body.buffer;
  } else if (req.file) {
    // Multipart path: buffer → data URI.
    const mime = req.file.mimetype;
    if (!["image/jpeg", "image/png", "image/webp"].includes(mime)) {
      return res.status(400).json({ message: "Only jpeg/png/webp images are supported" });
    }
    payload = `data:${mime};base64,${req.file.buffer.toString("base64")}`;
  }

  if (!payload) {
    return res.status(400).json({ message: "buffer (data URI) or file is required" });
  }

  // Namespace every passthrough upload so the foodo/ folder policy holds.
  const folder =
    typeof body.folder === "string" && /^foodo\/[a-z0-9_\-\/]{1,80}$/.test(body.folder)
      ? body.folder
      : "foodo/internal";

  const cloud = await v2.uploader.upload(payload, { folder });

  return res.send({
    url: cloud.secure_url,
    publicId: cloud.public_id,
  });
}));

export { router as cloudinaryRouter };
