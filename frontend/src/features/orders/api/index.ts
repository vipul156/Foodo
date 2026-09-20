// ============================================================
// Foodo — Orders Feature: TanStack Query API Hooks
// ============================================================

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { restaurantApi } from "@/lib/api-client";
import axios from "axios";
import type { IOrder, ICreateOrderPayload, PaymentStatus } from "@/types";

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

// ─── Razorpay: Create Order ─────────────────────────────────

export function useCreateRazorpayOrder() {
  return useMutation({
    mutationFn: async (orderId: string) => {
      const res = await axios.post<{
        razorpayOrderId: string;
        key: string;
      }>("/api/utils/payment/create", { orderId }, { withCredentials: true });
      return res.data;
    },
  });
}

// ─── Stripe: Create Checkout Session ─────────────────────────

export function useCreateStripeSession() {
  return useMutation({
    mutationFn: async (orderId: string) => {
      const res = await axios.post<{ url: string }>(
        "/api/utils/payment/stripe/create",
        { orderId },
        { withCredentials: true },
      );
      return res.data;
    },
  });
}

// ─── Order Payment Status (read-only polling) ────────────────
// After the gateway redirect the frontend polls this read-only endpoint —
// it can never fulfill a payment. The webhook (source of truth) marks the
// order paid in the background; the next poll unlocks the flow.

export interface IOrderPaymentStatus {
  success: boolean;
  orderId: string;
  paymentStatus: PaymentStatus;
  status: string;
  totalAmount?: number;
}

export function useOrderPaymentStatus(orderId: string | null) {
  return useQuery({
    queryKey: ["orders", orderId, "payment-status"],
    queryFn: async () => {
      const res = await restaurantApi.get<IOrderPaymentStatus>(
        `/order/${orderId}/status`,
      );
      return res;
    },
    enabled: !!orderId,
    // Poll every 2s and stop the moment the webhook has flipped the order
    refetchInterval: (query) =>
      query.state.data?.paymentStatus === "paid" ? false : 2000,
    refetchIntervalInBackground: false,
    retry: 1,
    staleTime: 0,
  });
}

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

// ─── Cancel Order ───────────────────────────────────────────

export function useCancelOrder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (orderId: string) => {
      const res = await restaurantApi.patch<{ message: string }>(
        `/order/${orderId}/cancel`,
      );
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["orders"] });
    },
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
