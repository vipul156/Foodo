import express from "express";
import dotenv from "dotenv";
import connectDB from "./config/db.js";
import cookieSession from "cookie-session";
import cors from 'cors';
import { restaurantRouter } from "./routes/restaurant.js";
import { menuItemRouter } from "./routes/menu-item.js";
import { cartRouter } from "./routes/cart.js";
import { orderRouter } from "./routes/order.js";
import { connectRabbitMQ } from "./config/rabbitmq.js";
import { startPaymentConsumer } from "./config/payment.consumer.js";

dotenv.config();

await connectRabbitMQ()
startPaymentConsumer()

const app = express();
app.use(cors());
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

app.listen(3001, () => {
  console.log("Server is running on port 3001");
  connectDB();
});
