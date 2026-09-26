import { Router } from "express";
import {
  getMenuItems,
  createMenuItemController,
  deleteMenuItemController,
  toogleMenuItemAvailability,
} from "../controllers/menuItem.js";
import { isAuth, isSeller } from "@foodo/backend-common";
import { uploadFile } from "@foodo/backend-common";
import { getMenuItemImageSignature } from "../controllers/upload.js";

const router = Router();

router.use(isAuth);

// Signed direct-upload: client fetches params here, then POSTs the file
// straight to Cloudinary. Auth-checked; folder is fixed server-side.
router.get("/upload-signature", isSeller, getMenuItemImageSignature);

router.get("/all/:id", getMenuItems);
router.post("/new", isSeller, uploadFile, createMenuItemController);
router.delete("/delete/:id", isSeller, deleteMenuItemController);
router.put("/toggle/:id", isSeller, toogleMenuItemAvailability);

export { router as menuItemRouter };