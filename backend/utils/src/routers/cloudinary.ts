import { Router } from "express";
import { tryCatch } from "../middlewares/trycatch.js";
import { v2 } from "cloudinary";

const router = Router();

router.post(
  "/upload",
  tryCatch(async (req, res) => {
    const { buffer } = req.body;
    const cloud = await v2.uploader.upload(buffer);

    return res.send({
      url: cloud.secure_url,
    });
  }),
);

export { router as cloudinaryRouter };
