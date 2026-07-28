import express from "express";
import dotenv from "dotenv";
import connectDB from "./config/db.js";
import cookieSession from "cookie-session";
import cors from 'cors'
import { authRoute } from "./routes/auth.js";

dotenv.config();

const app = express();
app.use(cors())
app.use(
  cookieSession({
    name: "session",
    keys: [process.env.COOKIE_SECRET!],
    maxAge: 24 * 60 * 60 * 1000,
  }),
);
app.use(express.json());

app.use('/api/auth', authRoute)

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log("Server is running on port ", PORT);
  connectDB();
});
