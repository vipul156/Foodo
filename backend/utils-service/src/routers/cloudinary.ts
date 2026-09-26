import { Router } from "express";
import { tryCatch } from "@foodo/backend-common";

const router = Router();

// ─── DEPRECATED — replaced by signed direct uploads ─────────
// This proxy used to receive base64 image payloads from restaurant-/
// rider-service and upload them to Cloudinary. Since
// @foodo/backend-common's createCloudinaryUploadSignature() landed,
// every service signs uploads LOCALLY (HMAC-SHA1, no network hop) and
// clients upload bytes straight to Cloudinary:
//
//   1. Client: GET /api/menu-item/upload-signature (or /restaurant/
//      upload-signature, or /api/rider/upload-signature)
//   2. Client: POST File → https://api.cloudinary.com/v1_1/<cloud>/image/upload
//   3. Client: passes the returned secure_url to the create/update endpoint
//
// The endpoint answers 410 Gone with a pointer at the new flow so stale
// deployments fail loudly instead of silently proxying bytes. It will be
// deleted in a future release; CLOUDINARY_* env vars have moved to the
// restaurant/rider services.
router.post(
  "/upload",
  tryCatch(async (req, res) => {
    return res.status(410).json({
      message:
        "This upload proxy is deprecated. Fetch a signed payload from the owning service's /upload-signature endpoint and POST the file directly to Cloudinary.",
    });
  }),
);

export { router as cloudinaryRouter };
