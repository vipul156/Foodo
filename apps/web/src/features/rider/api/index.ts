// ============================================================
// Foodo — Rider Feature: TanStack Query API Hooks
// ============================================================

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { riderApi } from "@/lib/api-client";
import type { IRider, IOrder } from "@/types";

// ─── Get Rider Profile ───────────────────────────────────────
// GET /myprofile — returns the authenticated rider's profile

export function useGetRiderProfile() {
  return useQuery({
    queryKey: ["rider", "profile"],
    queryFn: async () => {
      const res = await riderApi.get<{
        message: string;
        rider: IRider;
      }>("/myprofile");
      return res.rider;
    },
    retry: false,
    staleTime: 1000 * 60 * 2,
  });
}

// ─── Toggle Rider Availability ───────────────────────────────
// PATCH /toggle — updates availability status & location

export function useToggleRiderAvailability() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: {
      isAvailable: boolean;
      latitude: number;
      longitude: number;
    }) => {
      const res = await riderApi.patch<{
        message: string;
        rider: IRider;
      }>("/toggle", data);
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rider", "profile"] });
    },
  });
}

// ─── Get Available Orders ────────────────────────────────────
// GET /order/available — ready_for_rider orders near the rider.
// Fetched on login/refresh so offers broadcast *before* the rider was
// online are still visible; polls as a safety net alongside the socket.

export function useGetAvailableOrders(enabled: boolean) {
  return useQuery({
    queryKey: ["rider", "orders", "available"],
    queryFn: async () => {
      const res = await riderApi.get<{
        message: string;
        count: number;
        orders: IOrder[];
      }>("/order/available");
      return res.orders;
    },
    enabled,
    refetchInterval: 1000 * 15,
  });
}

// ─── Get Current Order ───────────────────────────────────────
// GET /order/current — returns the rider's current active order

export function useGetCurrentOrder() {
  return useQuery({
    queryKey: ["rider", "order", "current"],
    queryFn: async () => {
      try {
        const res = await riderApi.get<{
          message: string;
          order: IOrder;
        }>("/order/current");
        return res.order;
      } catch {
        return null;
      }
    },
    retry: false,
    refetchInterval: 1000 * 15,
  });
}

// ─── Accept Order ────────────────────────────────────────────
// POST /accept/:orderId — rider accepts a delivery order

export function useAcceptOrder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (orderId: string) => {
      const res = await riderApi.post<{
        message: string;
      }>(`/accept/${orderId}`);
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rider", "order", "current"] });
    },
  });
}

// ─── Update Order Status ─────────────────────────────────────
// PUT /order/update — rider updates the status of their current order

export function useUpdateOrderStatus() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: { orderId: string }) => {
      const res = await riderApi.put<{
        message: string;
        order: IOrder;
      }>("/order/update", data);
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rider", "order", "current"] });
    },
  });
}

// ─── Get Delivery History ────────────────────────────────────
// GET /order/history — delivered orders for the authenticated rider,
// newest first. Powers the Earnings and History pages.

export function useGetRiderDeliveryHistory() {
  return useQuery({
    queryKey: ["rider", "history"],
    queryFn: async () => {
      const res = await riderApi.get<{
        message: string;
        count: number;
        orders: IOrder[];
      }>("/order/history");
      return res.orders;
    },
    staleTime: 1000 * 60 * 1,
  });
}

// ─── Create Rider Profile ────────────────────────────────────
// POST /new (multipart) — first-time rider registration

export function useCreateRider() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (formData: FormData) => {
      const res = await riderApi.post<{
        message: string;
        rider: IRider;
      }>("/new", formData);
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rider", "profile"] });
    },
  });
}
