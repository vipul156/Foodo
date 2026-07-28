// ============================================================
// Foodo — Socket.IO Client Singleton
// ============================================================

import { io, Socket } from "socket.io-client";
import { getToken } from "./api-client";
import { useSocketStore } from "@/store/socket-store";

const REALTIME_URL =
  process.env.NEXT_PUBLIC_REALTIME_SERVICE_URL || "http://localhost:3002";

let socket: Socket | null = null;

/**
 * Get or create the Socket.IO connection.
 * Passes the JWT token in the handshake auth for the server to verify.
 *
 * NOTE: The realtime service expects `decode.user` in the JWT payload.
 * The auth service signs tokens as `{ id, email, role }` (no `.user` wrapper),
 * so the initial auth token may be rejected. If connection fails, obtain a
 * refreshed token (e.g. from the restaurant service's `/restaurant/my` endpoint
 * which returns `{ user: { ...user, restaurantId } }` wrapped tokens).
 */
export function getSocket(): Socket | null {
  return socket;
}

/**
 * Connect to the realtime Socket.IO server.
 * The server expects `auth: { token }` in the handshake and will
 * join the client to `user:<userId>` and `restaurant:<restaurantId>` rooms.
 */
export function connectSocket(token?: string): Socket | null {
  // Disconnect existing socket if any
  disconnectSocket();

  const authToken = token || getToken();
  if (!authToken) {
    console.warn("[Socket] No auth token available — skipping connection");
    return null;
  }

  socket = io(REALTIME_URL, {
    auth: { token: authToken },
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });

  socket.on("connect", () => {
    console.log("[Socket] Connected:", socket?.id);
    useSocketStore.getState().setConnected(true);
  });

  socket.on("disconnect", (reason) => {
    console.log("[Socket] Disconnected:", reason);
    useSocketStore.getState().setConnected(false);
  });

  socket.on("connect_error", (error) => {
    console.error("[Socket] Connection error:", error.message);
    useSocketStore.getState().setConnected(false);
  });

  return socket;
}

/**
 * Disconnect and clean up the socket connection.
 */
export function disconnectSocket(): void {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
  useSocketStore.getState().setConnected(false);
}

/**
 * Check if the socket is currently connected.
 */
export function isSocketConnected(): boolean {
  return socket?.connected ?? false;
}
