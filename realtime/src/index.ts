import express from "express";
import cors from "cors";
import http from "http";
import cookieSession from "cookie-session";
import { initSocket } from "./socket.js";
import { interRoute } from "./routes/internal.js";
import { connectRealtimeEvents } from "./config/rabbitmq.js";
import { connectRedisAdapter } from "./config/redis.js";
import dotenv from "dotenv"

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
app.use(express.json())

app.use("/api/internal",interRoute)

const server = http.createServer(app)
initSocket(server)

// Attach the Redis adapter before accepting connections (no-op when
// REDIS_URL is unset) so rooms are cluster-wide from the first socket.
await connectRedisAdapter()

// Consume order events from the RabbitMQ fanout exchange — services no
// longer need to reach realtime over HTTP to broadcast.
connectRealtimeEvents()

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'UP',
    uptime: process.uptime(),
    timestamp: Date.now()
  });
});

const PORT = process.env.PORT || 3002
server.listen(PORT, () => {
    console.log("Server started on port ", PORT);
});