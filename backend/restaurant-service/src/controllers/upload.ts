import type { Request, Response } from "express";
import { tryCatch, createCloudinaryUploadSignature } from "@foodo/backend-common";

// ─── Cloudinary signed-upload endpoint ───────────────────────
// The seller's browser fetches these signed params (auth-checked by the
// router's isAuth/isSeller middlewares), then POSTs the File DIRECTLY to
// Cloudinary — the image bytes never transit any backend service.
// Signing is local HMAC-SHA1 (<1ms); utils-service is out of the loop.
//
// Folders are fixed server-side per resource type so a client can never
// sign an upload into someone else's namespace.

export const getMenuItemImageSignature = tryCatch(
  async (req: Request, res: Response) => {
    const params = createCloudinaryUploadSignature({
      folder: "foodo/menu-items",
      tags: ["foodo", "menu-item"],
      transformation: "w_1200,h_1200,c_limit,q_auto",
    });

    return res.json(params);
  },
);

export const getRestaurantImageSignature = tryCatch(
  async (req: Request, res: Response) => {
    const params = createCloudinaryUploadSignature({
      folder: "foodo/restaurants",
      tags: ["foodo", "restaurant"],
      transformation: "w_1600,c_limit,q_auto",
    });

    return res.json(params);
  },
);
