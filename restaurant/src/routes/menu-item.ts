import { Router } from "express";
import {
  getMenuItems,
  createMenuItem,
  aiParseMenu,
  bulkCreateMenuItems,
  deleteMenuItem,
  toogleMenuItemAvailability,
} from "../controllers/menuItem.js";
import { isAuth, isSeller } from "../middlewares/isAuth.js";
import uploadFile from "../middlewares/multer.js";

const router = Router();

router.use(isAuth);

router.get("/all/:id", getMenuItems);
router.post("/new", isSeller, uploadFile, createMenuItem);
router.post("/ai-parse", isSeller, aiParseMenu);
router.post("/bulk", isSeller, bulkCreateMenuItems);
router.delete("/delete/:id", isSeller, deleteMenuItem);
router.put("/toggle/:id", isSeller, toogleMenuItemAvailability);

export { router as menuItemRouter };