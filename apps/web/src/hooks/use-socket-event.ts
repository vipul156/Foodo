// ============================================================
// Foodo — useSocketEvent Hook
// Listens to a specific socket event and calls the callback.
// Survives every lifecycle hazard:
//   - page mounts before the socket connects (waits, then attaches)
//   - realtime service restarts (re-attaches on reconnect)
//   - socket is recreated on auth change (re-attaches to the new one)
// No manual refresh required.
// ============================================================

"use client";

import { useEffect, useRef } from "react";
import { getSocket } from "@/lib/socket";
import { useSocketStore } from "@/store/socket-store";

type EventCallback = (...args: unknown[]) => void;

export function useSocketEvent(event: string, callback: EventCallback): void {
  const callbackRef = useRef<EventCallback>(callback);
  const isConnected = useSocketStore((s) => s.isConnected);

  // Keep the ref in sync with the latest callback — no stale closures
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const handler = (...args: unknown[]) => {
      callbackRef.current(...args);
    };
    const attach = () => {
      // idempotent — socket.on never double-registers the same fn
      socket.on(event, handler);
    };
    const detach = () => socket.off(event, handler);

    // isConnected flips true after every successful (re)connect, which
    // re-runs this effect and re-arms the listener on the live socket.
    // Initial mount before connection: attach immediately anyway; the
    // store flip will cover the actual connection moment.
    attach();

    return () => {
      detach();
    };
  }, [event, isConnected]);
}

/**
 * Subscribe to a Socket.IO event once (auto-unsubscribes after first fire).
 */
export function useSocketEventOnce(event: string, callback: EventCallback): void {
  const callbackRef = useRef<EventCallback>(callback);
  const isConnected = useSocketStore((s) => s.isConnected);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const handler = (...args: unknown[]) => {
      detach();
      callbackRef.current(...args);
    };
    const attach = () => {
      socket.off(event, handler); // avoid double-attach on reconnect
      socket.on(event, handler);
    };
    const detach = () => socket.off(event, handler);

    attach();

    return () => {
      detach();
    };
  }, [event, isConnected]);
}
