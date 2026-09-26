import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import cookieSession from "cookie-session";
import { adminRoutes } from "./routes/admin.js";
import serverlessHttp from "serverless-http";
import connectDB from "@foodo/backend-common/db";

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
    uptime: process.uptime(),
    timestamp: Date.now()
  });
});

const serverlessApp = serverlessHttp(app);

export const handler = async (event: any, context: any) => {
  context.callbackWaitsForEmptyEventLoop = false;
  await connectDB();
  return serverlessApp(event, context);
};

// ─── Local dev server (tsx --watch) ─────────────────────────
// `pnpm dev` runs this file directly; on Lambda the handler above is
// the entrypoint and this block never executes.
if (process.env.NODE_ENV !== "production" && process.env.AWS_LAMBDA_FUNCTION_NAME === undefined) {
  connectDB().then(() => {
    const PORT = process.env.PORT ?? 3001;
    app.listen(PORT, () => {
      console.log("Admin service (dev) listening on port", PORT);
    });
  });
}
