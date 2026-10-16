// ============================================================
// Foodo — Live Tracking Wrapper + Socket Hook
// ============================================================
// - `useRiderLocationFeed`: subscribes to `rider:location` pings for
//   a given order while the tracking panel is open.
// - `LiveTracking`: the public component. Leaflet mutates `window`,
//   so the map itself is dynamically imported with ssr disabled and
//   mounted only after the wrapper has measured a real height.

"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import type { LiveTrackingMapProps } from "./live-tracking-map";
import { getSocket } from "@/lib/socket";
import { useSocketEvent } from "@/hooks/use-socket-event";
import { SOCKET_EVENTS } from "@/lib/socket-events";
import { Bike } from "lucide-react";

// ─── Socket feed ──────────────────────────────────────────────

export interface RiderPing {
  latitude: number;
  longitude: number;
  at: number;
}

/**
 * Live rider position for an order. Returns the latest ping (or null).
 * Pings arrive only while the rider's app is streaming — an initial
 * null simply means "first ping hasn't landed yet".
 */
export function useRiderLocationFeed(
  orderId: string | null | undefined,
): RiderPing | null {
  const [ping, setPing] = useState<RiderPing | null>(null);

  const handler = useCallback(
    (payload: unknown) => {
      const data = payload as RiderPing & { orderId?: string };
      // Only accept pings for THIS order — multiple trackable orders
      // can be open at once, each with its own rider streaming.
      if (!data || !data.orderId || data.orderId !== orderId) return;
      if (typeof data.latitude !== "number" || typeof data.longitude !== "number") return;
      setPing({ latitude: data.latitude, longitude: data.longitude, at: data.at ?? Date.now() });
    },
    [orderId],
  );

  // piggyback on the same event name — payload carries orderId
  useSocketEvent(SOCKET_EVENTS.RIDER_LOCATION, handler);

  // Join/leave the order's tracking room so the realtime relay knows
  // where to fan the rider's pings. Runs on socket reconnects too.
  useEffect(() => {
    const socket = getSocket();
    if (!socket || !orderId) return;

    const join = () => socket.emit("order:track", { orderId });
    join();
    socket.on("connect", join);

    return () => {
      socket.off("connect", join);
      socket.emit("order:untrack", { orderId });
    };
  }, [orderId]);

  // Reset when switching orders
  useEffect(() => {
    setPing(null);
  }, [orderId]);

  return ping;
}

// ─── Dynamically loaded map (Leaflet needs window) ────────────

const LiveTrackingMap = dynamic(() => import("./live-tracking-map"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center rounded-xl bg-muted/50">
      <span className="text-xs text-muted-foreground">Loading map…</span>
    </div>
  ),
});

export function LiveTracking({
  orderId,
  restaurant,
  dropoff,
  tripEnded = false,
}: {
  orderId: string;
  restaurant: { name: string; latitude: number; longitude: number };
  dropoff: { formattedAddress: string; latitude: number; longitude: number };
  /** Delivered/cancelled: static recap — no socket feed, no GPS wait */
  tripEnded?: boolean;
}) {
  const rider = useRiderLocationFeed(tripEnded ? null : orderId);

  const hasRestaurantFix =
    Number.isFinite(restaurant.latitude) && Number.isFinite(restaurant.longitude);
  const hasDropoffFix =
    Number.isFinite(dropoff.latitude) && Number.isFinite(dropoff.longitude);

  if (!hasRestaurantFix || !hasDropoffFix) {
    return (
      <div className="flex h-44 items-center justify-center rounded-xl bg-muted/40 text-sm text-muted-foreground">
        Map unavailable — missing location data for this order.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border/60">
      <div className="relative h-48 sm:h-56">
        <LiveTrackingMap
          orderId={orderId}
          restaurant={restaurant}
          dropoff={dropoff}
          rider={rider ? { latitude: rider.latitude, longitude: rider.longitude } : null}
        />
      </div>

      {/* Legend strip */}
      <div className="flex items-center justify-between gap-2 border-t border-border/60 bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-violet-600" aria-hidden="true" />
          {restaurant.name}
        </span>
        <span className="inline-flex items-center gap-1.5">
          {rider ? (
            <>
              <span
                className="relative inline-flex h-2 w-2"
                aria-hidden="true"
              >
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              Rider live
            </>
          ) : tripEnded ? (
            <>
              <Bike className="h-3 w-3" aria-hidden="true" />
              Trip completed
            </>
          ) : (
            <>
              <Bike className="h-3 w-3" aria-hidden="true" />
              Waiting for rider GPS…
            </>
          )}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-600" aria-hidden="true" />
          Drop off
        </span>
      </div>
    </div>
  );
}
