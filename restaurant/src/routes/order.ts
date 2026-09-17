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
  getRiderDeliveryHistory,
  getReadyOrdersNearRider,
  updateOrderStatusRider,
  cancelOrder,
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
router.get("/ready/rider", getReadyOrdersNearRider);
router.get("/history/rider", getRiderDeliveryHistory);
router.put("/update/status/rider", updateOrderStatusRider);
router.patch("/:orderId/cancel", isAuth, cancelOrder);

export { router as orderRouter };
