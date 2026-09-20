import express from "express";
import { registerUser, loginUser, refreshUser, getUser, logoutUser } from "../controllers/auth.js";
import { getSocketToken } from "../controllers/socket-token.js";
import { isAuth } from "../middlewares/isAuth.js";

const router = express.Router();

router.post("/register", registerUser);

router.post("/login", loginUser);

// Rotates the refresh token and mints a new access token. Cookie-scoped
// to /api/auth so the browser only sends it here.
router.post("/refresh", refreshUser);

router.post("/logout", isAuth, logoutUser);

router.get('/me', isAuth, getUser)

// Short-lived minimal-claims JWT for the cross-origin Socket.IO
// handshake (cookies can't cross origins). Issued from the session.
router.get('/socket-token', isAuth, getSocketToken)

export { router as authRoute };
