import { Router } from "express";
import {
  submitPackingVerification,
  overridePackingVerification,
  getPackingVerification,
} from "../controllers/verification.js";
import {
  createOrder,
  fetchOrderForPayment,
  fetchRestaurantOrders,
  getRestaurantAnalytics,
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
// Seller analytics — MUST be registered before the /:orderId wildcard so
// "analytics" isn't captured as an order id
router.get("/analytics/:restaurantId", isAuth, isSeller, getRestaurantAnalytics);
router.put("/:orderId", isAuth, isSeller, updateOrderStatus);
router.get("/my", isAuth, getMyOrders);
// Read-only payment status for frontend polling after the gateway redirect
router.get("/:orderId/status", isAuth, getOrderPaymentStatus);
router.get("/:orderId", isAuth, fetchSingleOrder);

// Visual kitchen verification — seller-owned. These paths carry an
// extra segment (e.g. /verification/:id/packing) so they can never be
// shadowed by the single-segment /:orderId routes above.
router.post("/verification/:orderId/packing", isAuth, isSeller, submitPackingVerification);
router.put("/verification/:orderId/override", isAuth, isSeller, overridePackingVerification);
router.get("/verification/:orderId", isAuth, isSeller, getPackingVerification);
router.put("/assign/rider", assignOrderToRider);
router.get("/current/rider", getCurrentOrdersForRider);
router.get("/ready/rider", getReadyOrdersNearRider);
router.get("/history/rider", getRiderDeliveryHistory);
router.put("/update/status/rider", updateOrderStatusRider);
router.patch("/:orderId/cancel", isAuth, cancelOrder);

export { router as orderRouter };
