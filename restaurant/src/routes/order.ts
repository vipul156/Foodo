import { Router } from "express";
import {
  createOrder,
  fetchOrderForPayment,
  fetchRestaurantOrders,
  updateOrderStatus,
  getMyOrders,
  getOrderPaymentStatus,
  claimOrderForPayment,
  attachProviderOrder,
  getReconciliationCandidates,
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

// Internal: idempotent payment initiation + reconciliation (utils service)
router.post("/payment/claim/:id", claimOrderForPayment);
router.put("/payment/attached/:id", attachProviderOrder);
// Must be registered BEFORE GET /payment/:id so "reconciliation" isn't
// captured as an order id
router.get("/payment/reconciliation", getReconciliationCandidates);

router.get("/payment/:id", fetchOrderForPayment);
router.get("/order/:restaurantId", isAuth, isSeller, fetchRestaurantOrders);
router.put("/:orderId", isAuth, isSeller, updateOrderStatus);
router.get("/my", isAuth, getMyOrders);
// Read-only payment status for frontend polling after the gateway redirect
router.get("/:orderId/status", isAuth, getOrderPaymentStatus);
router.get("/:orderId", isAuth, fetchSingleOrder);
router.put("/assign/rider", assignOrderToRider);
router.get("/current/rider", getCurrentOrdersForRider);
router.get("/ready/rider", getReadyOrdersNearRider);
router.get("/history/rider", getRiderDeliveryHistory);
router.put("/update/status/rider", updateOrderStatusRider);
router.patch("/:orderId/cancel", isAuth, cancelOrder);

export { router as orderRouter };
