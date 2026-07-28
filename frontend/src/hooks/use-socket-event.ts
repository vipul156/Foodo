// ============================================================
// Foodo — useSocketEvent Hook
// Listens to a specific socket event and calls the callback
// Uses useRef pattern to avoid stale closures without manual deps
// ============================================================

"use client";

import { useEffect, useRef } from "react";
import { getSocket } from "@/lib/socket";

type EventCallback = (...args: unknown[]) => void;

/**
 * Subscribe to a Socket.IO event.
 * Automatically cleans up the listener on unmount.
 * Uses a ref internally so the callback is always fresh — no need
 * to worry about stale closures or manual dependency arrays.
 *
 * @example
 * ```ts
 * useSocketEvent("order:update", (payload) => {
 *   console.log("Order updated:", payload);
 * });
 * ```
 */
export function useSocketEvent(event: string, callback: EventCallback): void {
  const callbackRef = useRef<EventCallback>(callback);

  // Keep the ref in sync with the latest callback
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const handler = (...args: unknown[]) => {
      callbackRef.current(...args);
    };

    socket.on(event, handler);

    return () => {
      socket.off(event, handler);
    };
  }, [event]);
}

/**
 * Subscribe to a Socket.IO event once (auto-unsubscribes after first call).
 */
export function useSocketEventOnce(event: string, callback: EventCallback): void {
  const callbackRef = useRef<EventCallback>(callback);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const handler = (...args: unknown[]) => {
      callbackRef.current(...args);
    };

    socket.once(event, handler);

    return () => {
      socket.off(event, handler);
    };
  }, [event]);
}
