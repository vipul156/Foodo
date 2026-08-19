import { Router } from "express";
import {
  createOrder,
  fetchOrderForPayment,
  fetchRestaurantOrders,
  updateOrderStatus,
  getMyOrders,
  fetchSingleOrder,
  assignOrderToRider,
  getCurrentOrdersForRider,
  updateOrderStatusRider,
} from "../controllers/order.js";
import { isAuth, isSeller } from "../middlewares/isAuth.js";

const router = Router();

router.post("/new", isAuth, createOrder);
router.get("/payment/:id", fetchOrderForPayment);
router.get("/order/:restaurantId", isAuth, isSeller, fetchRestaurantOrders);
router.put("/:orderId", isAuth, isSeller, updateOrderStatus);
router.get("/my", isAuth, getMyOrders);
router.get("/:orderId", isAuth, fetchSingleOrder);
router.put("/assign/rider", assignOrderToRider);
router.get("/current/rider", getCurrentOrdersForRider);
router.put("/update/status/rider", updateOrderStatusRider);

export { router as orderRouter };
