import { Router } from "express";
import { isAuth, isRider } from "../middlewares/isAuth.js";
import {
    acceptOrder,
  createRider,
  fetchAvailableOrders,
  fetchMyCurrentOrder,
  fetchMyDeliveryHistory,
  fetchMyProfile,
  releaseRiderInternal,
  toogleRiderAvailablity,
  updateOrderStatus,
} from "../controller/rider.js";
import uploadFile from "../middlewares/multer.js";
import { submitProofOfDelivery } from "../controller/pod.js";

const router = Router();

// Internal: called by restaurant service when an assigned order is cancelled.
// Must be registered before isAuth — it authenticates via x-internal-key.
router.put("/release/internal", releaseRiderInternal)

router.use(isAuth, isRider);

router.post("/new", uploadFile, createRider);

router.get("/myprofile", fetchMyProfile);
router.patch("/toggle", toogleRiderAvailablity);

router.post("/accept/:orderId", acceptOrder);
router.get("/order/available", fetchAvailableOrders);
router.get("/order/current", fetchMyCurrentOrder)
router.get("/order/history", fetchMyDeliveryHistory)
router.put("/order/update", updateOrderStatus)

// Proof of delivery — drop-off photo verified by the AI tier, verdict
// attached to the delivery completion (advisory, never blocks).
router.post("/order/pod", submitProofOfDelivery)

// Proof of delivery — drop-off photo verified by the AI tier, verdict
// attached to the delivery completion (advisory, never blocks).
router.post("/order/pod", submitProofOfDelivery)

export { router as riderRouter };
