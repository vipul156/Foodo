import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import agentRouter from "./routes/agent.js";
import { connectRabbitMQ, onChannelReady } from "./config/rabbitmq.js";
import { consumeClaimEvents } from "./config/claim.consumer.js";
import { connectDB } from "./config/db.js";

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

const app = express();

app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ limit: "15mb", extended: true }));

app.use("/api/agent", agentRouter);

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "UP",
    uptime: process.uptime(),
    timestamp: Date.now(),
  });
});

const PORT = process.env.PORT || 3008;

const start = async () => {
  await connectDB();
  app.listen(PORT, () => {
    console.log("AI orchestrator running on port", PORT);
  });
};

start();

// RabbitMQ connects in the background; the dispute consumer re-attaches
// on every fresh channel (resilient to broker restarts).
connectRabbitMQ();
onChannelReady((channel) => consumeClaimEvents(channel));
