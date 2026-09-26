import { Router } from "express";
import {
  createOrder,
  fetchRestaurantOrders,
  getRestaurantAnalytics,
  updateOrderStatus,
  getMyOrders,
  getOrderPaymentStatus,
  claimOrderForPayment,
  attachProviderOrder,
  fetchSingleOrder,
  updateOrderStatusRider,
  cancelOrder,
} from "../controllers/order.js";
import { isAuth, isSeller } from "@foodo/backend-common";

const router = Router();

router.post("/new", isAuth, createOrder);

// Internal: idempotent payment initiation + reconciliation (utils service)
router.post("/payment/claim/:id", claimOrderForPayment);
router.put("/payment/attached/:id", attachProviderOrder);

router.get("/order/:restaurantId", isAuth, isSeller, fetchRestaurantOrders);
// Seller analytics — MUST be registered before the /:orderId wildcard so
// "analytics" isn't captured as an order id
router.get("/analytics/:restaurantId", isAuth, isSeller, getRestaurantAnalytics);
router.put("/:orderId", isAuth, isSeller, updateOrderStatus);
router.get("/my", isAuth, getMyOrders);
// Read-only payment status for frontend polling after the gateway redirect
router.get("/:orderId/status", isAuth, getOrderPaymentStatus);
router.get("/:orderId", isAuth, fetchSingleOrder);
router.put("/update/status/rider", updateOrderStatusRider);
router.patch("/:orderId/cancel", isAuth, cancelOrder);

export { router as orderRouter };
