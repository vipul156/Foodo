import { Router } from "express";
import { isInternal } from "../middlewares/internal.js";
import {
  listRestaurants,
  verifyRestaurant,
  getRestaurantStats,
  getOrderStats,
  getOrderSummary,
  getBatchableOrders,
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
// Dispatch enrichment (ai-dispatch swarm)
router.get("/orders/batchable", getBatchableOrders);
router.get("/orders/:id/summary", getOrderSummary);

export { router as internalRouter };
