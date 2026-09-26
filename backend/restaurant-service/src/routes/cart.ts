import express from "express";
import { addToCart, getCart, clearCartController, icreamentQuantity, decrementQuantity, removeItem } from "../controllers/cart.js";
import { isAuth } from "@foodo/backend-common";

const router = express.Router();

router.use(isAuth)

router.post("/add", addToCart);
router.get("/all", getCart);
router.delete("/clear", clearCartController);
router.put("/increase", icreamentQuantity);
router.put("/decrease", decrementQuantity);
router.delete("/remove", removeItem);

export { router as cartRouter };
