import { Router } from "express";
import {
  verifyPacking,
  verifyDelivery,
  getVerificationsForOrder,
} from "../controllers/verification.js";
import { isInternal } from "../middlewares/isInternal.js";
import { verificationLimiter } from "../config/rate-limit.js";

const router = Router();

// All verification endpoints are internal-only: the restaurant/rider
// services proxy here server-side (holding the human's session), so the
// browser never talks to the AI tier directly. Rate-limited per-IP as a
// second layer (callers are our own services, so limits are generous).
router.use(isInternal);

router.post("/packing", verificationLimiter, verifyPacking);
router.post("/delivery", verificationLimiter, verifyDelivery);
router.get("/order/:orderId", verificationLimiter, getVerificationsForOrder);

export { router as verificationRouter };
