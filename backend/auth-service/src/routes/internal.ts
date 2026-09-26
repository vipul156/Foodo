import { Router } from "express";
import { isInternal } from "../middlewares/internal.js";
import { listUsers, getUserStats } from "../controllers/internal.js";

// Internal contract for other services (currently the admin panel).
// All routes authenticate via the shared x-internal-key header.
const router = Router();

router.use(isInternal);

router.get("/users", listUsers);
router.get("/users/stats", getUserStats);

export { router as internalRoute };
