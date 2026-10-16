// ============================================================
// Foodo — Rider Location Streaming Hook
// ============================================================
// While the rider is online with an active delivery, streams GPS
// position pings over the existing Socket.IO connection. The realtime
// service relays each ping to the `order:{orderId}` room, where the
// customer's tracking map (and the seller board) consumes it.
//
// Lifecycle:
//   - No active order or rider offline → no watching, no emits
//   - watchPosition fires on movement (high accuracy, 5s min interval)
//   - Pings are throttled client-side to one per 5 seconds
//   - Room join for `order:{orderId}` happens on the customer side;
//     the rider emit is fire-and-forget (delivery UI doesn't wait)

"use client";

import { useEffect, useRef } from "react";
import { getSocket } from "@/lib/socket";

interface LocationPing {
  orderId: string;
  latitude: number;
  longitude: number;
}

const MIN_PING_INTERVAL_MS = 5000;

export function useRiderLocationStream(
  orderId: string | null | undefined,
  enabled: boolean,
): void {
  // Keep the last emitted time in a ref so the throttle survives re-renders
  const lastPingAtRef = useRef(0);

  useEffect(() => {
    if (!enabled || !orderId) return;

    const socket = getSocket();
    if (!socket) return;

    if (typeof navigator === "undefined" || !navigator.geolocation) return;

    const emitPing = (latitude: number, longitude: number) => {
      const now = Date.now();
      if (now - lastPingAtRef.current < MIN_PING_INTERVAL_MS) return;
      lastPingAtRef.current = now;

      const ping: LocationPing = { orderId: orderId!, latitude, longitude };
      socket.emit("rider:location", ping);
    };

    const watchId = navigator.geolocation.watchPosition(
      (pos) => emitPing(pos.coords.latitude, pos.coords.longitude),
      // Silent-fail: GPS denial while delivering shouldn't spam errors.
      // The first ping failure usually means permission was revoked —
      // watchPosition keeps trying but nothing emits until it succeeds.
      () => {},
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 },
    );

    return () => {
      navigator.geolocation.clearWatch(watchId);
    };
  }, [orderId, enabled]);
}
