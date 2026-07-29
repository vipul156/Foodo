import express from "express";
import dotenv from "dotenv";
import connectDB from "./config/db.js";
import cors from "cors";
import cookieSession from "cookie-session";
import { connectRabbitMQ } from "./config/rabbitmq.js";
import { riderRouter } from "./routes/rider.js";
import { startOrderReadyConsumer } from "./config/orderReady.consumer.js";

dotenv.config();

await connectRabbitMQ()
startOrderReadyConsumer()

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

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
app.use("/rider", riderRouter);

const PORT = process.env.PORT || 3004
app.listen(PORT, () => {
    console.log("Server running on port ", PORT);
    connectDB()
});