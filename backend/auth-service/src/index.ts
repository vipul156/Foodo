import express from "express";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import cookieSession from "cookie-session";
import serverlessHttp from "serverless-http";
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from "aws-lambda";

import { authRoute } from "./routes/auth.js";
import { cookieSessionOptions } from "./lib/tokens.js";

dotenv.config();

const app = express();

// Trust API Gateway proxy headers so secure cookies & IP detection work
app.set("trust proxy", 1);


app.use(cookieParser());
app.use(cookieSession(cookieSessionOptions()));
app.use(express.json());

// Mount ONLY public auth endpoints
app.use("/api/auth", authRoute);

app.get("/health", (req, res) => {
  res.status(200).json({ status: "UP", timestamp: Date.now() });
});

const serverlessApp = serverlessHttp(app);

// Lambda-only entrypoint: no connectDB() — the DynamoDB client is
// created lazily per warm container, nothing to wire up per request.
export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  context.callbackWaitsForEmptyEventLoop = false;
  return serverlessApp(event, context) as unknown as APIGatewayProxyResult;
};