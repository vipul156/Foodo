import express from "express";
import { registerUser, loginUser, getUser } from "../controllers/auth.js";
import { isAuth } from "../middlewares/isAuth.js";

const router = express.Router();

router.post("/register", registerUser);

router.post("/login", loginUser);

router.get('/me',isAuth, getUser)

export { router as authRoute };
