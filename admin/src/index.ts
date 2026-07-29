import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import cookieSession from "cookie-session";
import { adminRoutes } from "./routes/admin.js";

dotenv.config();

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

const app = express();
app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(
  cookieSession({
    name: "session",
    keys: [process.env.COOKIE_SECRET!],
    maxAge: 24 * 60 * 60 * 1000,
  }),
);
app.use(express.json());

const port = process.env.PORT || 3006;

app.use("/api", adminRoutes);

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
