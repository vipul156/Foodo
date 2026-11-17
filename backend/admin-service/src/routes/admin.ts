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
import { getPendingReviews, resolveReview } from "../controllers/reviews.js";
import { getDispatchSnapshot } from "../controllers/dispatch.js";
import { isAuth, isAdmin } from "@foodo/backend-common";

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

// AI escalation queue — the human work list the arbitration agent
// parks unresolved cases in.
router.get("/reviews", getPendingReviews);
router.patch("/reviews/:id/resolve", resolveReview);

// Dispatch swarm: ready orders the AI couldn't hand to a rider, plus the
// swarm's own container counters.
router.get("/dispatch", getDispatchSnapshot);

export { router as adminRoutes };
