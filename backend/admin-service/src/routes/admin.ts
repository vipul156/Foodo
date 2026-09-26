import { Router, type RequestHandler } from "express";
import {
  getPendingRestaurants,
  getAllRestaurants,
  getPendingRiders,
  getAllRiders,
  getAllUsers,
  verifyRestaurant,
  verifyRider,
  getPlatformStats,
} from "../controllers/admin.js";
import { isAuth, isAdmin } from "../middlewares/isAuth.js";

const router = Router();

// All admin routes require authentication + admin role
// Cast needed due to Express 5 type strictness with middleware return types
router.use("/", isAuth as unknown as RequestHandler);
router.use("/", isAdmin as unknown as RequestHandler);

router.get("/stats", getPlatformStats);
router.get("/restaurant/pending", getPendingRestaurants);
router.get("/restaurant/all", getAllRestaurants);
router.get("/rider/pending", getPendingRiders);
router.get("/rider/all", getAllRiders);
router.get("/user/all", getAllUsers);
router.patch("/verify/rider/:id", verifyRider);
router.patch("/verify/restaurant/:id", verifyRestaurant);

export { router as adminRoutes };
