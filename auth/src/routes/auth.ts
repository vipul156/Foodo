import express from "express";
import { registerUser, loginUser, refreshUser, getUser, logoutUser } from "../controllers/auth.js";
import { getSocketToken } from "../controllers/socket-token.js";
import { isAuth } from "../middlewares/isAuth.js";
import {
  authFloodLimiter,
  bruteForceLimiter,
} from "../middlewares/rate-limit.js";

const router = express.Router();

router.post("/register", authFloodLimiter, registerUser);

// Login gets both layers: per-IP flood guard + per-IP+email failure
// counter enforced BEFORE the handler touches the database.
router.post("/login", authFloodLimiter, bruteForceLimiter, loginUser);

// Rotates the refresh token and mints a new access token. Cookie-scoped
// to /api/auth so the browser only sends it here.
router.post("/refresh", refreshUser);

router.post("/logout", isAuth, logoutUser);

router.get('/me', isAuth, getUser)

// Short-lived minimal-claims JWT for the cross-origin Socket.IO
// handshake (cookies can't cross origins). Issued from the session.
router.get('/socket-token', isAuth, getSocketToken)

export { router as authRoute };
