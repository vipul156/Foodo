import { Router } from "express";
import {
  getMenuItems,
  createMenuItemController,
  bulkCreateMenuItems,
  deleteMenuItemController,
  toogleMenuItemAvailability,
} from "../controllers/menuItem.js";
import { isAuth, isSeller } from "@foodo/backend-common";
import { uploadFile } from "@foodo/backend-common";
import { getMenuItemImageSignature } from "../controllers/upload.js";

const router = Router();

// Public route: customers browse menu items without requiring login
router.get("/all/:id", getMenuItems);

router.use(isAuth);

// Signed direct-upload: client fetches params here, then POSTs the file
// straight to Cloudinary. Auth-checked; folder is fixed server-side.
router.get("/upload-signature", isSeller, getMenuItemImageSignature);

router.post("/new", isSeller, uploadFile, createMenuItemController);
// AI menu parser publish: the owner-verified review grid → one batch.
router.post("/bulk", isSeller, bulkCreateMenuItems);
router.delete("/delete/:id", isSeller, deleteMenuItemController);
router.put("/toggle/:id", isSeller, toogleMenuItemAvailability);

export { router as menuItemRouter };