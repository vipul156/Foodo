import express from "express";
import dotenv from "dotenv";
import connectDB from "./config/db.js";
import cors from "cors";
import cookieSession from "cookie-session";
import { connectRabbitMQ } from "./config/rabbitmq.js";
import { riderRouter } from "./routes/rider.js";
import { internalRouter } from "./routes/internal.js";
import { startOrderReadyConsumer } from "./config/orderReady.consumer.js";
import { startRiderEventConsumer } from "./config/riderEvent.consumer.js";
import { seedDemoRider } from "./seed/demo-rider.js";

dotenv.config();

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
// ─── Body limits: restrictive default, scoped headroom ─────
// 1mb covers every JSON API. Only rider registration (/api/rider/new)
// carries a base64 image (data-URI) that gets forwarded to the upload
// service, so only that path gets headroom. Scoped parsers MUST come
// before the global one — the global parser would 413 the request first.
app.use(
  "/api/rider/new",
  express.json({ limit: "10mb" }),
  express.urlencoded({ limit: "10mb", extended: true }),
);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ limit: "1mb", extended: true }));
app.use("/api/rider", riderRouter);
// Internal service-to-service contract (admin reads go through here)
app.use("/api/internal", internalRouter);

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'UP',
    uptime: process.uptime(),
    timestamp: Date.now()
  });
});

const PORT = process.env.PORT || 3004
app.listen(PORT, () => {
    console.log("Server running on port ", PORT);
    connectDB().then(() => seedDemoRider());

    // RabbitMQ connects in the background — the API boots and serves even
    // while the broker is down. The manager retries with exponential
    // backoff and re-attaches the consumers once the connection returns.
    connectRabbitMQ();
    startOrderReadyConsumer();
    startRiderEventConsumer();
});