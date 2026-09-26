import { Router } from "express";
import { isInternal } from "../middlewares/internal.js";
import { listRiders, verifyRider, getRiderStats } from "../controller/internal.js";

// Internal contract for other services (currently the admin panel).
// All routes authenticate via the shared x-internal-key header.
const router = Router();

router.use(isInternal);

router.get("/riders", listRiders);
router.get("/riders/stats", getRiderStats);
router.patch("/riders/:id/verify", verifyRider);

export { router as internalRouter };
