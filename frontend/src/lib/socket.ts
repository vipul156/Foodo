// ============================================================
// Foodo — Socket.IO Client Singleton
// ============================================================

import { io, Socket } from "socket.io-client";
import { useSocketStore } from "@/store/socket-store";
import { fetchSocketToken, getSocketToken } from "./api-client";

const REALTIME_URL =
  process.env.NEXT_PUBLIC_REALTIME_SERVICE_URL || "http://localhost:3002";

let socket: Socket | null = null;

/**
 * Get the current socket instance.
 */
export function getSocket(): Socket | null {
  return socket;
}

/**
 * Connect to the realtime Socket.IO server.
 * The realtime service is cross-origin, so cookies don't apply — the
 * socket authenticates with a short-lived bootstrap JWT (fetched with
 * the session cookie, held in memory only).
 */
export async function connectSocket(): Promise<Socket | null> {
  // Disconnect existing socket if any
  disconnectSocket();

  // Reuse the in-memory bootstrap token, or fetch a fresh one
  const token = getSocketToken() ?? (await fetchSocketToken());
  if (!token) {
    console.warn("[Socket] No bootstrap token; skipping connect");
    return null;
  }

  socket = io(REALTIME_URL, {
    auth: { token }, // passes JWT via handshake.auth.token
    transports: ["websocket", "polling"],
    // Never give up: retries forever with capped backoff. If the realtime
    // service restarts, the browser rejoins its rooms and keeps receiving
    // events — no silent dead socket, no manual refresh.
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
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
