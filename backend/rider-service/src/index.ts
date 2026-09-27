import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cookieSession from "cookie-session";
import { riderRouter } from "./routes/rider.js";

export const app = express();

app.use(
  cookieSession({
    name: "session",
    keys: [process.env.COOKIE_SECRET!],
    maxAge: 24 * 60 * 60 * 1000,
  }),
);

// 10mb limit for rider registration base64 payload
app.use(
  "/api/rider/new",
  express.json({ limit: "10mb" }),
  express.urlencoded({ limit: "10mb", extended: true }),
);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ limit: "1mb", extended: true }));

app.use("/api/rider", riderRouter);

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "UP",
    timestamp: Date.now(),
  });
});