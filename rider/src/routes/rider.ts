import { Router } from "express";
import { isAuth, isRider } from "../middlewares/isAuth.js";
import {
    acceptOrder,
  createRider,
  fetchMyCurrentOrder,
  fetchMyProfile,
  toogleRiderAvailablity,
  updateOrderStatus,
} from "../controller/rider.js";
import uploadFile from "../middlewares/multer.js";

const router = Router();

router.use(isAuth, isRider);

router.post("/new", uploadFile, createRider);

router.get("/myprofile", fetchMyProfile);
router.patch("/toggle", toogleRiderAvailablity);

router.post("/accept/:orderId", acceptOrder);
router.get("/order/current", fetchMyCurrentOrder)
router.put("/order/update", updateOrderStatus)

export { router as riderRouter };
