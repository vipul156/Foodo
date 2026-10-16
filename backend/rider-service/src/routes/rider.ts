import { Router } from "express";
import { isAuth, isRider } from "@foodo/backend-common";
import {
    acceptOrder,
  createRiderController,
  fetchAvailableOrders,
  fetchMyCurrentOrder,
  fetchMyDeliveryHistory,
  fetchMyProfile,
  toogleRiderAvailablity,
  updateOrderStatus,
} from "../controller/rider.js";
import { uploadFile } from "@foodo/backend-common";
import { getRiderImageSignature } from "../controller/upload.js";

const router = Router();

// [REMOVED] PUT /release/internal — cancellation releases now arrive as
// order.cancelled events on the fanout exchange (see riderEvent.consumer).

router.use(isAuth, isRider);

// Signed direct-upload: client fetches params here, then POSTs the photo
// straight to Cloudinary. Auth-checked; folder is fixed server-side.
router.get("/upload-signature", getRiderImageSignature);

router.post("/new", uploadFile, createRiderController);

router.get("/myprofile", fetchMyProfile);
router.patch("/toggle", toogleRiderAvailablity);

router.post("/accept/:orderId", acceptOrder);
router.get("/order/available", fetchAvailableOrders);
router.get("/order/current", fetchMyCurrentOrder)
router.get("/order/history", fetchMyDeliveryHistory)
router.put("/order/update", updateOrderStatus)

export { router as riderRouter };
