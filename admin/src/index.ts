import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { adminRoutes } from "./routes/admin.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const port = process.env.PORT || 3006;

app.use("/api", adminRoutes);

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
