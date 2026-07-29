// ============================================================
// Foodo — Restaurants Feature: TanStack Query API Hooks
// ============================================================

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { restaurantApi } from "@/lib/api-client";
import type {
  IRestaurant,
  IMenuItem,
  ICartItem,
  ICartResponse,
  IAddress,
  ICreateAddressPayload,
} from "@/types";

// ─── Get My Restaurant ───────────────────────────────────────

export function useGetMyRestaurant() {
  return useQuery({
    queryKey: ["restaurant", "my"],
    queryFn: async () => {
      const res = await restaurantApi.get<{
        message: string;
        restaurant: IRestaurant;
        token?: string;
      }>("/restaurant/my");
      return res.restaurant;
    },
    retry: false,
  });
}

// ─── Create Restaurant ───────────────────────────────────────

export function useCreateRestaurant() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: Partial<IRestaurant>) => {
      const res = await restaurantApi.post<{
        message: string;
        restaurant: IRestaurant;
      }>("/restaurant/new", data);
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["restaurant"] });
    },
  });
}

// ─── Update Restaurant Status ────────────────────────────────

export function useUpdateRestaurantStatus() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (status: boolean) => {
      const res = await restaurantApi.put<{
        message: string;
        restaurant: IRestaurant;
      }>("/restaurant/status", { status });
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["restaurant"] });
    },
  });
}

// ─── Update Restaurant Details ───────────────────────────────

export function useUpdateRestaurantDetails() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: {
      name?: string;
      description?: string;
      phone?: number;
    }) => {
      const res = await restaurantApi.put<{
        message: string;
        restaurant: IRestaurant;
      }>("/restaurant/update", data);
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["restaurant"] });
    },
  });
}

// ─── Get Menu Items ──────────────────────────────────────────

export function useGetMenuItems(restaurantId: string) {
  return useQuery({
    queryKey: ["menu-items", restaurantId],
    queryFn: async () => {
      const res = await restaurantApi.get<{
        message: string;
        menuItems: IMenuItem[];
      }>(`/menu-item/all/${restaurantId}`);
      return res.menuItems;
    },
    enabled: !!restaurantId,
  });
}

// ─── Create Menu Item ────────────────────────────────────────

export function useCreateMenuItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: FormData) => {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_RESTAURANT_SERVICE_URL}/menu-item/new`,
        {
          method: "POST",
          credentials: "include",
          body: data,
        },
      );
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["menu-items"] });
    },
  });
}

// ─── Toggle Menu Item Availability ───────────────────────────

export function useToggleMenuItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (itemId: string) => {
      const res = await restaurantApi.put<{
        message: string;
        menuItem: IMenuItem;
      }>(`/menu-item/toggle/${itemId}`);
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["menu-items"] });
    },
  });
}

// ─── Delete Menu Item ────────────────────────────────────────

export function useDeleteMenuItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (itemId: string) => {
      const res = await restaurantApi.delete<{ message: string }>(
        `/menu-item/delete/${itemId}`,
      );
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["menu-items"] });
    },
  });
}

// ─── Cart ────────────────────────────────────────────────────

export function useGetCart() {
  return useQuery({
    queryKey: ["cart"],
    queryFn: async () => {
      const res = await restaurantApi.get<ICartResponse>("/cart/all");
      return res;
    },
  });
}

export function useAddToCart() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: { restaurantId: string; itemId: string }) => {
      const res = await restaurantApi.post<{
        success: boolean;
        message: string;
        cart: ICartItem;
      }>("/cart/add", data);
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cart"] });
    },
  });
}

export function useClearCart() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const res = await restaurantApi.delete<{ success: boolean; message: string }>(
        "/cart/clear",
      );
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cart"] });
    },
  });
}

// ─── Addresses ───────────────────────────────────────────────

export function useGetAddresses() {
  return useQuery({
    queryKey: ["addresses"],
    queryFn: async () => {
      const res = await restaurantApi.get<{
        success: boolean;
        data: IAddress[];
      }>("/address/all");
      return res.data;
    },
  });
}

export function useCreateAddress() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: ICreateAddressPayload) => {
      const res = await restaurantApi.post<{
        success: boolean;
        message: string;
        data: IAddress;
      }>("/address/new", data);
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["addresses"] });
    },
  });
}
