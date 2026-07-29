// ============================================================
// Foodo — Admin Feature: TanStack Query API Hooks
// ============================================================

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { adminApi } from "@/lib/api-client";
import type { IPendingRestaurant, IPendingRider } from "@/types";

// ─── Get Pending Restaurants ────────────────────────────────
// GET /restaurant/pending

export function useGetPendingRestaurants() {
  return useQuery({
    queryKey: ["admin", "pending-restaurants"],
    queryFn: async () => {
      const res = await adminApi.get<{
        count: number;
        restaurants: IPendingRestaurant[];
      }>("/restaurant/pending");
      return res.restaurants;
    },
  });
}

// ─── Get Pending Riders ─────────────────────────────────────
// GET /rider/pending

export function useGetPendingRiders() {
  return useQuery({
    queryKey: ["admin", "pending-riders"],
    queryFn: async () => {
      const res = await adminApi.get<{
        count: number;
        riders: IPendingRider[];
      }>("/rider/pending");
      return res.riders;
    },
  });
}

// ─── Verify Restaurant ──────────────────────────────────────
// PATCH /verify/restaurant/:id

export function useVerifyRestaurant() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const res = await adminApi.patch<{ message: string }>(
        `/verify/restaurant/${id}`,
      );
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "pending-restaurants"] });
    },
  });
}

// ─── Verify Rider ───────────────────────────────────────────
// PATCH /verify/rider/:id

export function useVerifyRider() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const res = await adminApi.patch<{ message: string }>(
        `/verify/rider/${id}`,
      );
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "pending-riders"] });
    },
  });
}
