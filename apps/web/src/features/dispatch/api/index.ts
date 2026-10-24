// ============================================================
// Foodo — Dispatch Feature: TanStack Query API Hooks
// ============================================================
// ai-dispatch assigns a rider when an order goes ready_for_rider. When
// it can't (no rider in range, weather, an unassignable batch) it parks
// the order in a TTL'd pool and moves on.
//
// The snapshot endpoint is internal-key gated, so the browser talks to
// admin-service, which adds the key server-side. Wire shape is the
// Python service's own snake_case — nothing is renamed in transit.

import { useQuery } from "@tanstack/react-query";
import { adminApi } from "@/lib/api-client";

export interface LatLng {
  latitude: number;
  longitude: number;
}

export interface DispatchHealth {
  status: string;
  orders_dispatched: number;
  batches_formed: number;
  broadcasts: number;
  weather_degraded: boolean;
}

export interface DispatchPoolRow {
  order_id: string | null;
  restaurant_id: string | null;
  pickup: LatLng | null;
  dropoff: LatLng | null;
  prep_minutes: number | null;
  /** Epoch seconds — the swarm's own clock. */
  parked_at: number | null;
}

export interface DispatchSnapshot {
  health: DispatchHealth;
  pending_pool: DispatchPoolRow[];
}

// ─── Read the swarm snapshot ────────────────────────────────
// GET /admin/dispatch — 15s cadence: this is an ops view, not a live
// console, and the pool moves on the order of minutes.

export function useDispatchSnapshot() {
  return useQuery({
    queryKey: ["dispatch", "snapshot"],
    queryFn: async () => {
      return adminApi.get<DispatchSnapshot>("/dispatch");
    },
    refetchInterval: 15_000,
    staleTime: 0,
  });
}
