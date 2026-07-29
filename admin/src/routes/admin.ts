import { Router, type RequestHandler } from "express";
import {
  getPendingRestaurants,
  getPendingRiders,
  verifyRestaurant,
  verifyRider,
} from "../controllers/admin.js";
import { isAuth, isAdmin } from "../middlewares/isAuth.js";

const router = Router();

// All admin routes require authentication + admin role
// Cast needed due to Express 5 type strictness with middleware return types
router.use("/", isAuth as unknown as RequestHandler);
router.use("/", isAdmin as unknown as RequestHandler);

router.get("/restaurant/pending", getPendingRestaurants);
router.get("/rider/pending", getPendingRiders);
router.patch("/verify/rider/:id", verifyRider);
router.patch("/verify/restaurant/:id", verifyRestaurant);

export { router as adminRoutes };
