// ============================================================
// Foodo — Orders Feature: TanStack Query API Hooks
// ============================================================

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { restaurantApi } from "@/lib/api-client";
import type { IOrder, ICreateOrderPayload } from "@/types";

// ─── Create Order ────────────────────────────────────────────

export function useCreateOrder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: ICreateOrderPayload) => {
      const res = await restaurantApi.post<{
        message: string;
        orderId: string;
        amount: number;
      }>("/order/new", data);
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      queryClient.invalidateQueries({ queryKey: ["cart"] });
    },
  });
}

// ─── Get My Orders ───────────────────────────────────────────

export function useGetMyOrders() {
  return useQuery({
    queryKey: ["orders", "my"],
    queryFn: async () => {
      const res = await restaurantApi.get<{
        success: boolean;
        count: number;
        orders: IOrder[];
      }>("/order/my");
      return res.orders;
    },
  });
}

// ─── Get Single Order ────────────────────────────────────────

export function useGetOrder(orderId: string) {
  return useQuery({
    queryKey: ["orders", orderId],
    queryFn: async () => {
      const res = await restaurantApi.get<{
        success: boolean;
        order: IOrder;
      }>(`/order/${orderId}`);
      return res.order;
    },
    enabled: !!orderId,
  });
}

// ─── Fetch Restaurant Orders ─────────────────────────────────

export function useGetRestaurantOrders(restaurantId: string, limit?: number) {
  return useQuery({
    queryKey: ["orders", "restaurant", restaurantId],
    queryFn: async () => {
      const res = await restaurantApi.get<{
        success: boolean;
        count: number;
        orders: IOrder[];
      }>(`/order/order/${restaurantId}`, {
        params: { limit: limit?.toString() },
      });
      return res.orders;
    },
    enabled: !!restaurantId,
  });
}

// ─── Update Order Status ─────────────────────────────────────

export function useUpdateOrderStatus() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      orderId,
      status,
    }: {
      orderId: string;
      status: string;
    }) => {
      const res = await restaurantApi.put<{
        message: string;
        order: IOrder;
      }>(`/order/${orderId}`, { status });
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["orders"] });
    },
  });
}
