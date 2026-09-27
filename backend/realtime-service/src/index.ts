import express from "express";
import http from "http";
import cookieSession from "cookie-session";
import { initSocket } from "./socket.js";
import { connectRealtimeEvents } from "./config/events.js";
import { connectRedisAdapter } from "./config/redis.js";
import serverlessHttp from "serverless-http";
import dotenv from "dotenv"

dotenv.config();



const app = express();


app.use(
  cookieSession({
    name: "session",
    keys: [process.env.COOKIE_SECRET!],
    maxAge: 24 * 60 * 60 * 1000,
  }),
);
app.use(express.json())

// [REMOVED] The /api/internal/emit HTTP endpoint — socket broadcasts are
// consumed exclusively from the RabbitMQ fanout exchange now (the last
// HTTP caller, rider-service's order-ready consumer, was migrated).

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

const serverlessApp = serverlessHttp(app);

export const handler = async (event: any, context: any) => {
  context.callbackWaitsForEmptyEventLoop = false;
  return serverlessApp(event, context);
};