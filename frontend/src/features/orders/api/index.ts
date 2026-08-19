// ============================================================
// Foodo — Orders Feature: TanStack Query API Hooks
// ============================================================

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { restaurantApi } from "@/lib/api-client";
import axios from "axios";
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

// ─── Razorpay: Verify Payment ───────────────────────────────

export function useVerifyRazorpayPayment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: {
      orderId: string;
      razorpay_payment_id: string;
      razorpay_order_id: string;
      razorpay_signature: string;
    }) => {
      const res = await axios.post<{ message: string }>(
        "/api/utils/payment/verify",
        data,
        { withCredentials: true },
      );
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      queryClient.invalidateQueries({ queryKey: ["cart"] });
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

// ─── Stripe: Verify Payment ──────────────────────────────────

export function useVerifyStripePayment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (sessionId: string) => {
      const res = await axios.post<{ message: string }>(
        "/api/utils/payment/stripe/verify",
        { sessionId },
        { withCredentials: true },
      );
      return res.data;
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
