import { Router } from "express";
import { getIo } from "../socket.js";

const router = Router();

router.post("/emit", (req, res) => {
  if (req.headers["x-internal-key"] !== process.env.INTERNAL_SERVICE_KEY) {
    throw new Error("Forbidden");
  }

  const { event, room, payload } = req.body;

  if (!event || !room) {
    throw new Error("Event and Room are Required");
  }

  const io = getIo();

  io.to(room).emit(event, payload ?? {});

  return res.json({ success: true });
});

export {router as interRoute}