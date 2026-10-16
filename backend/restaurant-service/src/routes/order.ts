import { Router } from "express";
import {
  createOrder,
  fetchRestaurantOrders,
  getRestaurantAnalytics,
  updateOrderStatus,
  getMyOrders,
  getOrderPaymentStatus,
  claimOrderForPaymentController,
  fetchSingleOrder,
  cancelOrderController,
} from "../controllers/order.js";
import { isAuth, isSeller } from "@foodo/backend-common";

const router = Router();

router.post("/new", isAuth, createOrder);

// Internal: idempotent payment initiation (utils service). The only
// remaining sync cross-service call — the claim response (amount + any
// previously attached provider order id) is needed BEFORE the provider
// intent can be created. Attach + rider status + rider release all moved
// to RabbitMQ events on the fanout exchange.
router.post("/payment/claim/:id", claimOrderForPaymentController);

router.get("/order/:restaurantId", isAuth, isSeller, fetchRestaurantOrders);
// Seller analytics — MUST be registered before the /:orderId wildcard so
// "analytics" isn't captured as an order id
router.get("/analytics/:restaurantId", isAuth, isSeller, getRestaurantAnalytics);
router.put("/:orderId", isAuth, isSeller, updateOrderStatus);
router.get("/my", isAuth, getMyOrders);
// Read-only payment status for frontend polling after the gateway redirect
router.get("/:orderId/status", isAuth, getOrderPaymentStatus);
router.get("/:orderId", isAuth, fetchSingleOrder);
router.patch("/:orderId/cancel", isAuth, cancelOrderController);

export { router as orderRouter };
