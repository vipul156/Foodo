import express from "express";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import cookieSession from "cookie-session";
import serverlessHttp from "serverless-http";

import connectDB from "@foodo/backend-common/db";
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

export const handler = async (event: any, context: any) => {
  context.callbackWaitsForEmptyEventLoop = false;
  await connectDB();
  return serverlessApp(event, context);
};