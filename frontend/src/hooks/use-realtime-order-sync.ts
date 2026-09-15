// ============================================================
// Foodo — Global Realtime Order Sync Hook
// ============================================================
// Listens to every order-lifecycle socket event and invalidates
// the TanStack Query caches so every mounted dashboard (customer
// orders, seller board, rider dashboard) refetches automatically.
// No manual refresh needed anywhere.
// ============================================================

"use client";

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSocketEvent } from "./use-socket-event";
import { SOCKET_EVENTS } from "@/lib/socket-events";

export function useRealtimeOrderSync(): void {
  const queryClient = useQueryClient();

  const invalidateOrderData = useCallback(() => {
    // Covers: customer "orders"/"my", seller "orders"/"restaurant/:id",
    // and anything keyed under "orders"
    queryClient.invalidateQueries({ queryKey: ["orders"] });
    // Covers: rider current order, profile/availability, earnings, history
    queryClient.invalidateQueries({ queryKey: ["rider"] });
  }, [queryClient]);

  useSocketEvent(SOCKET_EVENTS.ORDER_NEW, invalidateOrderData);
  useSocketEvent(SOCKET_EVENTS.ORDER_UPDATE, invalidateOrderData);
  useSocketEvent(SOCKET_EVENTS.RIDER_ASSIGNED, invalidateOrderData);
  useSocketEvent(SOCKET_EVENTS.ORDER_DELIVERED, invalidateOrderData);
  useSocketEvent(SOCKET_EVENTS.ORDER_AVAILABLE, invalidateOrderData);
}
