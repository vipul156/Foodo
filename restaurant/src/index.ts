import dotenv from "dotenv";
dotenv.config();

import express from "express";
import connectDB from "./config/db.js";
import cookieSession from "cookie-session";
import cors from 'cors';
import { restaurantRouter } from "./routes/restaurant.js";

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";
import { menuItemRouter } from "./routes/menu-item.js";
import { cartRouter } from "./routes/cart.js";
import { orderRouter } from "./routes/order.js";
import { connectRabbitMQ } from "./config/rabbitmq.js";
import { startPaymentConsumer } from "./config/payment.consumer.js";
import { startRiderEventConsumer } from "./config/riderEvent.consumer.js";
import { addressRoute } from "./routes/address.js";
import { internalRouter } from "./routes/internal.js";
import { seedDemoRestaurant } from "./seed/demo-restaurant.js";

const app = express();
app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(
  cookieSession({
    name: "session",
    keys: [process.env.COOKIE_SECRET!],
    maxAge: 24 * 60 * 60 * 1000,
  }),
);

// ─── Body limits: restrictive default, scoped headroom ─────
// 1mb covers every JSON API (orders, carts, status updates). The only
// oversized bodies are base64 image data-URIs forwarded to the upload
// service from the menu-item + restaurant create/update routes, so only
// those get headroom. The scoped parsers MUST come before the global one
// — Express matches middleware in order and the global parser would 413
// an oversized upload before the scoped parser sees it.
app.use(
  ["/api/menu-item/new", "/api/restaurant/new", "/api/restaurant/update"],
  express.json({ limit: "10mb" }),
  express.urlencoded({ limit: "10mb", extended: true }),
);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ limit: "1mb", extended: true }));

app.use("/api/restaurant", restaurantRouter)
app.use("/api/menu-item", menuItemRouter)
app.use("/api/cart", cartRouter)
app.use("/api/order", orderRouter)
app.use("/api/address", addressRoute)
// Internal service-to-service contract (admin reads go through here)
app.use("/api/internal", internalRouter)

const PORT = process.env.PORT || 3003

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'UP',
    uptime: process.uptime(),
    timestamp: Date.now()
  });
});

app.listen(PORT, () => {
  console.log("Server is running on port ", PORT);
  connectDB().then(() => seedDemoRestaurant());

  // RabbitMQ connects in the background — the API boots and serves even
  // while the broker is down. The manager retries with exponential
  // backoff and re-attaches the consumers once the connection returns.
  connectRabbitMQ();
  startPaymentConsumer();
  startRiderEventConsumer();
});
