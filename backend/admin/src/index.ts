import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import cookieSession from "cookie-session";
import { adminRoutes } from "./routes/admin.js";
import serverlessHttp from "serverless-http";

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
  return serverlessApp(event, context);
};
