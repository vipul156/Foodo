// ============================================================
// Foodo — Realtime Client (native WebSocket over API Gateway)
// ============================================================
// The realtime tier is an API Gateway WebSocket API + Lambda now
// (backend/realtime-service), not a Socket.IO server:
//
//   connect:  wss://…execute-api…/{stage}?token=<bootstrap JWT>
//             ($connect verifies the token and auto-joins the
//             user:{id} and restaurant:{id} rooms server-side)
//   down:     { event: "order:update", payload: {...} }
//   up:       { action: "order:track", orderId: "…" }  (also
//             order:untrack, rider:location)
//
// This module keeps the Socket.IO-style surface the app already
// uses (getSocket/on/off/emit + a synthetic "connect" event) so
// hooks and pages did not have to change.

import { useSocketStore } from "@/store/socket-store";
import { fetchSocketToken, getSocketToken } from "./api-client";

const REALTIME_WS_URL =
  process.env.NEXT_PUBLIC_REALTIME_WS_URL || "ws://localhost:3002";

type Listener = (payload: unknown) => void;

const RECONNECT_DELAY_BASE_MS = 500;
const RECONNECT_DELAY_MAX_MS = 5000;

class RealtimeSocket {
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private token: string;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;

  connected = false;

  constructor(token: string) {
    this.token = token;
  }

  connect(): void {
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.closedByUser = false;
    const ws = new WebSocket(
      `${REALTIME_WS_URL}?token=${encodeURIComponent(this.token)}`,
    );
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this.reconnectAttempt = 0;
      useSocketStore.getState().setConnected(true);
      // Synthetic event so consumers can re-arm room joins after a
      // reconnect (the old Socket.IO "connect" event behaved this way).
      this.dispatch("connect", undefined);
    };

    ws.onmessage = (message) => {
      try {
        const data = JSON.parse(message.data as string) as {
          event?: string;
          payload?: unknown;
        };
        if (data.event) this.dispatch(data.event, data.payload);
      } catch {
        // Non-JSON frame — ignore.
      }
    };

    ws.onclose = () => {
      this.connected = false;
      useSocketStore.getState().setConnected(false);
      // Never give up: retry forever with capped backoff. If the
      // WebSocket API or a Lambda hiccups, the browser rejoins its
      // rooms ($connect re-runs) and keeps receiving events.
      if (!this.closedByUser) this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose always follows onerror — reconnection is handled there.
      useSocketStore.getState().setConnected(false);
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(
      RECONNECT_DELAY_BASE_MS * 2 ** this.reconnectAttempt,
      RECONNECT_DELAY_MAX_MS,
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private dispatch(event: string, payload: unknown): void {
    this.listeners.get(event)?.forEach((listener) => listener(payload));
  }

  on(event: string, listener: Listener): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
  }

  off(event: string, listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
  }

  /** Client → server action. Fire-and-forget, like the old emits. */
  emit(action: string, data?: Record<string, unknown> | object): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ action, ...data }));
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.connected = false;
  }
}

let socket: RealtimeSocket | null = null;

/**
 * Get the current socket instance.
 */
export function getSocket(): RealtimeSocket | null {
  return socket;
}

/**
 * Connect to the realtime WebSocket API.
 * The API is cross-origin, so cookies don't apply — the socket
 * authenticates with a short-lived bootstrap JWT (fetched with the
 * session cookie, held in memory only) passed as ?token=.
 */
export async function connectSocket(): Promise<RealtimeSocket | null> {
  // Disconnect existing socket if any
  disconnectSocket();

  // Reuse the in-memory bootstrap token, or fetch a fresh one
  const token = getSocketToken() ?? (await fetchSocketToken());
  if (!token) {
    console.warn("[Socket] No bootstrap token; skipping connect");
    return null;
  }

  socket = new RealtimeSocket(token);
  socket.connect();
  return socket;
}

/**
 * Disconnect and clean up the socket connection.
 */
export function disconnectSocket(): void {
  if (socket) {
    socket.close();
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
