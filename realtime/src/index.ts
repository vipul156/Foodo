import express from "express";
import cors from "cors";
import http from "http";
import { initSocket } from "./socket.js";
import { interRoute } from "./routes/internal.js";

const app = express();

app.use(cors());
app.use(express.json())

app.use("/api/v1/internal",interRoute)

const server = http.createServer(app)
initSocket(server)

server.listen(3002, () => {
    console.log("Server started on port 3002");
});