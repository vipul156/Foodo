import express from "express";
import dotenv from "dotenv";
import connectDB from "./config/db.js";
import cookieSession from "cookie-session";
import cors from 'cors'
import { authRoute } from "./routes/auth.js";
import { internalRoute } from "./routes/internal.js";
import { seedDemoUsers } from "./seed/demo-users.js";

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

dotenv.config();

const app = express();
app.use(cors({ origin: FRONTEND_URL, credentials: true }))
app.use(
  cookieSession({
    name: "session",
    keys: [process.env.COOKIE_SECRET!],
    maxAge: 24 * 60 * 60 * 1000,
  }),
);
app.use(express.json());

app.use('/api/auth', authRoute)
// Internal service-to-service contract (admin reads go through here)
app.use('/api/internal', internalRoute)

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'UP',
    uptime: process.uptime(),
    timestamp: Date.now()
  });
});

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log("Server is running on port ", PORT);
  connectDB().then(() => seedDemoUsers());
});
