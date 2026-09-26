import { Router } from "express";
import { getMenuItems } from "../controllers/menuItem.js";
import { createMenuItem } from "../controllers/menuItem.js";
import { isAuth, isSeller } from "@foodo/backend-common";
import { deleteMenuItem } from "../controllers/menuItem.js";
import { toogleMenuItemAvailability } from "../controllers/menuItem.js";
import { uploadFile } from "@foodo/backend-common";

const router = Router();

router.use(isAuth);

router.get("/all/:id", getMenuItems);
router.post("/new", isSeller, uploadFile, createMenuItem);
router.delete("/delete/:id", isSeller, deleteMenuItem);
router.put("/toggle/:id", isSeller, toogleMenuItemAvailability);

export { router as menuItemRouter };