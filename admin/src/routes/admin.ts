import { Router } from "express";
import {
  getPendingRestaurants,
  getPendingRiders,
  verifyRestaurant,
  verifyRider,
} from "../controllers/admin.js";

const router = Router();

router.get("/admin/restaurant/pending", getPendingRestaurants);
router.get("/admin/rider/pending", getPendingRiders);
router.patch("/verify/rider/:id", verifyRider);
router.patch("/verify/restaurant/:id", verifyRestaurant);

export { router as adminRoutes };
