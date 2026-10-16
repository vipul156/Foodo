// ============================================================
// Foodo — Admin Feature: TanStack Query API Hooks
// ============================================================

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { adminApi } from "@/lib/api-client";
import type {
  IPendingRestaurant,
  IAllRestaurant,
  IPendingRider,
  IAllRider,
  IPlatformUser,
  IPlatformStats,
} from "@/types";

// ─── Get Platform Stats (analytics) ─────────────────────────
// GET /stats — aggregated platform numbers for the admin analytics page

export function useGetPlatformStats() {
  return useQuery({
    queryKey: ["admin", "stats"],
    queryFn: async () => {
      const res = await adminApi.get<IPlatformStats>("/stats");
      return res;
    },
    staleTime: 1000 * 60 * 2,
  });
}

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

// ─── Get All Restaurants ────────────────────────────────────
// GET /restaurant/all — every restaurant, open ones first

export function useGetAllRestaurants() {
  return useQuery({
    queryKey: ["admin", "all-restaurants"],
    queryFn: async () => {
      const res = await adminApi.get<{
        count: number;
        restaurants: IAllRestaurant[];
      }>("/restaurant/all");
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

// ─── Get All Riders ─────────────────────────────────────────
// GET /rider/all — every rider, online ones first

export function useGetAllRiders() {
  return useQuery({
    queryKey: ["admin", "all-riders"],
    queryFn: async () => {
      const res = await adminApi.get<{
        count: number;
        riders: IAllRider[];
      }>("/rider/all");
      return res.riders;
    },
  });
}

// ─── Get All Users ──────────────────────────────────────────
// GET /user/all — newest first, optional ?role= filter

export function useGetAllUsers(role?: string) {
  return useQuery({
    queryKey: ["admin", "users", role ?? "all"],
    queryFn: async () => {
      const res = await adminApi.get<{
        count: number;
        users: IPlatformUser[];
      }>("/user/all", { params: { role } });
      return res.users;
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
