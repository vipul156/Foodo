import express from "express";
import dotenv from "dotenv";
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
import { addressRoute } from "./routes/address.js";
import { internalRouter } from "./routes/internal.js";
import { seedDemoRestaurant } from "./seed/demo-restaurant.js";

dotenv.config();

await connectRabbitMQ()
startPaymentConsumer()

const app = express();
app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(
  cookieSession({
    name: "session",
    keys: [process.env.COOKIE_SECRET!],
    maxAge: 24 * 60 * 60 * 1000,
  }),
);

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
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
});
