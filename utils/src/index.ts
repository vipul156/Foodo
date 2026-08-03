import express from "express";
import dotenv from "dotenv";
import cloudinary from "cloudinary";
import cors from "cors";
import { cloudinaryRouter } from "./routers/cloudinary.js";
import { connectRabbitMQ } from "./config/rabbitmq.js";
import paymentRouter from "./routers/payment.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

const { ClOUD_NAME, CLOUD_API_KEY, CLOUD_API_SECRET } = process.env;

if (!ClOUD_NAME || !CLOUD_API_KEY || !CLOUD_API_SECRET) {
  throw new Error("Cloudinary credentials are not defined");
}

cloudinary.v2.config({
  cloud_name: ClOUD_NAME,
  api_key: CLOUD_API_KEY,
  api_secret: CLOUD_API_SECRET,
});

app.use("/api/utils/", cloudinaryRouter);
app.use("/api/utils/payment", paymentRouter);

connectRabbitMQ();

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'UP',
    uptime: process.uptime(),
    timestamp: Date.now()
  });
});

const PORT = process.env.PORT || 3005
app.listen(PORT, () => {
    console.log("Server running on port ", PORT);
});
