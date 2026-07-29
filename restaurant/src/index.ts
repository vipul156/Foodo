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

app.use(express.json());
app.use(restaurantRouter)
app.use(menuItemRouter)
app.use(cartRouter)
app.use(orderRouter)

const PORT = process.env.PORT || 3003
app.listen(PORT, () => {
  console.log("Server is running on port ", PORT);
  connectDB();
});
