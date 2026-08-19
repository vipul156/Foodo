import express from "express";
import { addToCart, getCart, clearCart, icreamentQuantity, decrementQuantity, removeItem } from "../controllers/cart.js";
import { isAuth } from "../middlewares/isAuth.js";

const router = express.Router();

router.use(isAuth)

router.post("/add", addToCart);
router.get("/all", getCart);
router.delete("/clear", clearCart);
router.put("/increase", icreamentQuantity);
router.put("/decrease", decrementQuantity);
router.delete("/remove", removeItem);

export { router as cartRouter };
