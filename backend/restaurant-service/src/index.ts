import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cookieSession from "cookie-session";
import serverlessHttp from "serverless-http";
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from "aws-lambda";

import { restaurantRouter } from "./routes/restaurant.js";
import { menuItemRouter } from "./routes/menu-item.js";
import { cartRouter } from "./routes/cart.js";
import { orderRouter } from "./routes/order.js";
import { addressRoute } from "./routes/address.js";
import { paymentQueueHandler, riderEventsHandler } from "./config/consumers.js";

// ─── Express app (route surface unchanged, Lambda-mounted) ──
const app = express();

app.use(
  cookieSession({
    name: "session",
    keys: [process.env.COOKIE_SECRET!],
    maxAge: 24 * 60 * 60 * 1000,
  }),
);

// ─── Body limits: restrictive default, scoped headroom ─────
// 1mb covers every JSON API. Only the base64 image data-URI paths
// forwarded to Cloudinary from menu-item + restaurant create/update get
// headroom. Scoped parsers MUST come before the global one.
app.use(
  ["/api/menu-item/new", "/api/restaurant/new", "/api/restaurant/update"],
  express.json({ limit: "10mb" }),
  express.urlencoded({ limit: "10mb", extended: true }),
);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ limit: "1mb", extended: true }));

app.use("/api/restaurant", restaurantRouter);
app.use("/api/menu-item", menuItemRouter);
app.use("/api/cart", cartRouter);
app.use("/api/order", orderRouter);
app.use("/api/address", addressRoute);

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "UP",
    timestamp: Date.now(),
  });
});

// ─── Lambda entrypoints (the ONLY entrypoints) ──────────────
// One deployment artifact, three handlers:
//   handler         — API Gateway HTTP API (serverless-http)
//   paymentConsumer — SQS PAYMENT_QUEUE_URL (payment success work queue)
//   riderEvents     — SQS RIDER_EVENTS_QUEUE_URL (SNS-filtered events)
//
// No app.listen, no PORT, no dev mode: this service exists only as
// Lambda. Local testing runs through `sam local` / `serverless-offline`
// style emulation of these same handlers, never a listening server.

const serverlessApp = serverlessHttp(app);

export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  context.callbackWaitsForEmptyEventLoop = false;
  // No connectDB(): DynamoDB needs no connection setup — the SDK's
  // reused client (warm container) resolves the endpoint per call.
  return serverlessApp(event, context) as unknown as APIGatewayProxyResult;
};

export const paymentConsumer = paymentQueueHandler;

export const riderEvents = riderEventsHandler;
