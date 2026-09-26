import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cookieSession from "cookie-session";
import serverlessHttp from "serverless-http";
import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";

import { riderRouter } from "./routes/rider.js";
import { orderReadyHandler, riderEventsHandler } from "./config/consumers.js";

const app = express();


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

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'UP',
    timestamp: Date.now()
  });
});

// ─── Lambda entrypoints (the ONLY entrypoints) ──────────────
// One deployment artifact, three handlers:
//   handler      — API Gateway HTTP API (serverless-http)
//   orderReady   — SQS ORDER_QUEUE_URL (rider matcher work queue)
//   riderEvents  — SQS RIDER_EVENTS_QUEUE_URL (SNS-filtered events)
//
// No app.listen, no PORT, no dev mode: this service exists only as
// Lambda. The DynamoDB client is created lazily per warm container —
// no connection setup on the hot path.

const serverlessApp = serverlessHttp(app);

export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  context.callbackWaitsForEmptyEventLoop = false;
  return serverlessApp(event, context) as unknown as APIGatewayProxyResult;
};

export const orderReady = orderReadyHandler;

export const riderEvents = riderEventsHandler;
