// ============================================================
// Foodo — Verification Feature: TanStack Query API Hooks
// ============================================================

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { restaurantApi, riderApi } from "@/lib/api-client";
import type { IOrder, IVerificationResponse } from "@/types";

// ─── Seller: Submit Packing Snapshot ─────────────────────────
// POST /order/verification/:orderId/packing — multipart-free: the photo
// is pre-downscaled to a JPEG data URI and sent as JSON.

export function useSubmitPackingVerification(restaurantId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ orderId, file }: { orderId: string; file: File }) => {
      const { fileToVerifiedDataUri, isDataUriSizeOk } = await import(
        "@/lib/image-capture"
      );
      const image = await fileToVerifiedDataUri(file);
      if (!isDataUriSizeOk(image)) {
        throw new Error("Photo too large after compression — try again");
      }

      return restaurantApi.post<{ success: boolean; verification: IVerificationResponse; order: IOrder }>(
        `/order/verification/${orderId}/packing`,
        { image },
      );
    },
    onSuccess: () => {
      // Broad "orders" prefix invalidation also refreshes any single-order
      // cache entries (they nest under the same prefix in this app).
      queryClient.invalidateQueries({ queryKey: ["orders"] });
    },
  });
}

// ─── Seller: Override a Flagged Verification ─────────────────
// PUT /order/verification/:orderId/override — records the audit note
// and clears the ready-gate block.

export function useOverridePackingVerification(restaurantId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ orderId, note }: { orderId: string; note: string }) => {
      return restaurantApi.put<{ success: boolean; message: string; order: IOrder }>(
        `/order/verification/${orderId}/override`,
        { note },
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["orders", "restaurant", restaurantId] });
    },
  });
}

// ─── Seller: Fetch Current Verification State ────────────────
// GET /order/verification/:orderId

export function useGetPackingVerification(orderId: string) {
  return useQuery({
    queryKey: ["verification", "packing", orderId],
    queryFn: async () => {
      const res = await restaurantApi.get<{
        success: boolean;
        verification: {
          status: "verified" | "flagged" | "unverified";
          flag: string | null;
          confidence: number;
          missing: string[];
          override: { at: string; byUserId: string; note: string } | null;
          verifiedAt: string | null;
          evidenceUrl: string | null;
        } | null;
        orderStatus: string;
      }>(`/order/verification/${orderId}`);
      return res;
    },
    enabled: !!orderId,
    staleTime: 0,
  });
}

// ─── Rider: Submit Proof of Delivery ─────────────────────────
// POST /rider/order/pod — completes the delivery WITH the AI-verified
// drop-off photo attached. Returns the verdict for the confirmation UI.

export function useSubmitProofOfDelivery() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ file }: { file: File }) => {
      const { fileToVerifiedDataUri, isDataUriSizeOk } = await import(
        "@/lib/image-capture"
      );
      const image = await fileToVerifiedDataUri(file);
      if (!isDataUriSizeOk(image)) {
        throw new Error("Photo too large after compression — try again");
      }

      return riderApi.post<{
        success: boolean;
        message: string;
        verification: {
          status: "verified" | "flagged" | "unverified";
          flag: string | null;
          confidence: number;
          notes: string | null;
          evidenceUrl: string | null;
          provider: string | null;
          attached: boolean;
        };
      }>("/order/pod", { image });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rider", "order", "current"] });
      queryClient.invalidateQueries({ queryKey: ["rider", "profile"] });
      queryClient.invalidateQueries({ queryKey: ["rider", "history"] });
    },
  });
}
