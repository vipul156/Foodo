import type { Request, Response } from "express";
import { tryCatch, createCloudinaryUploadSignature } from "@foodo/backend-common";

// ─── Cloudinary signed-upload endpoint (rider KYC / profile photo) ──
// The rider's browser fetches these signed params (auth-checked by the
// router's isAuth/isRider middlewares), then POSTs the File DIRECTLY to
// Cloudinary — the photo never transits this (or any) backend service.
// Signing is local HMAC-SHA1 (<1ms); utils-service is out of the loop.
//
// The folder is fixed server-side so a client can never sign an upload
// into another namespace.

export const getRiderImageSignature = tryCatch(
  async (req: Request, res: Response) => {
    const params = createCloudinaryUploadSignature({
      folder: "foodo/riders/kyc",
      tags: ["foodo", "rider", "kyc"],
      transformation: "w_800,h_800,c_limit,q_auto",
    });

    return res.json(params);
  },
);
