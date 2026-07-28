import express from "express";
import dotenv from "dotenv";
import connectDB from "./config/db.js";
import cors from "cors";
import { connectRabbitMQ } from "./config/rabbitmq.js";
import { riderRouter } from "./routes/rider.js";
import { startOrderReadyConsumer } from "./config/orderReady.consumer.js";

dotenv.config();

await connectRabbitMQ()
startOrderReadyConsumer()

const app = express();

app.use(cors());
app.use(express.json());
app.use("/rider", riderRouter);

const PORT = process.env.PORT || 3004
app.listen(PORT, () => {
    console.log("Server running on port ", PORT);
    connectDB()
});