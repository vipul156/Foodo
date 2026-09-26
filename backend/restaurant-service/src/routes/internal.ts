import { Router } from "express";
import { isInternal } from "../middlewares/internal.js";
import {
  listRestaurants,
  verifyRestaurant,
  getRestaurantStats,
  getOrderStats,
} from "../controllers/internal.js";

// Internal contract for other services (currently the admin panel).
// All routes authenticate via the shared x-internal-key header.
const router = Router();

router.use(isInternal);

// Restaurants — owned by this service
router.get("/restaurants", listRestaurants);
router.get("/restaurants/stats", getRestaurantStats);
router.patch("/restaurants/:id/verify", verifyRestaurant);

// Orders — owned by this service
router.get("/orders/stats", getOrderStats);

export { router as internalRouter };
