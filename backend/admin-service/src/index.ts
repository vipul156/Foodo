import express from "express";
import dotenv from "dotenv";
import cookieSession from "cookie-session";
import serverlessHttp from "serverless-http";
import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";

import { adminRoutes } from "./routes/admin.js";

dotenv.config();

const app = express();

app.use(
  cookieSession({
    name: "session",
    keys: [process.env.COOKIE_SECRET!],
    maxAge: 24 * 60 * 60 * 1000,
  }),
);
// Admin reads/writes are small JSON — no upload paths, so the global
// limit stays tight (was 50mb: trivial DoS amplification).
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ limit: "1mb", extended: true }));

app.use("/api/admin", adminRoutes);

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'UP',
    timestamp: Date.now(),
  });
});

const serverlessApp = serverlessHttp(app);

// ─── Lambda-only entrypoint ─────────────────────────────────
// No connectDB() — DynamoDB needs no connection setup; the SDK's reused
// client (warm container) resolves the endpoint per call. No dev-mode
// app.listen block: this service exists only as Lambda.
export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  context.callbackWaitsForEmptyEventLoop = false;
  return serverlessApp(event, context) as unknown as APIGatewayProxyResult;
};
