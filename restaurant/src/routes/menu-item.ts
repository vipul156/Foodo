import { Router } from "express";
import { getMenuItems } from "../controllers/menuItem.js";
import { createMenuItem } from "../controllers/menuItem.js";
import { isAuth, isSeller } from "../middlewares/isAuth.js";
import { deleteMenuItem } from "../controllers/menuItem.js";
import { toogleMenuItemAvailability } from "../controllers/menuItem.js";
const router = Router();

router.use(isAuth)

router.get("/all/:id", getMenuItems);
router.post("/new", isSeller, createMenuItem);
router.delete("/delete/:id", isSeller, deleteMenuItem);
router.put("/toggle/:id", isSeller, toogleMenuItemAvailability);

export { router as menuItemRouter };