// ============================================================
// Foodo — Verification Feature: TanStack Query API Hooks
// ============================================================

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { restaurantApi, riderApi } from "@/lib/api-client";
import type {
  IPackingVerification,
  IVerificationResponse,
  VerificationStatus,
} from "@/types";

// ─── Seller: Submit Packing Snapshot ─────────────────────────
// POST /order/verification/:orderId/packing — multipart-free: the photo
// is pre-downscaled to a JPEG data URI and sent as JSON.

export function useSubmitPackingVerification() {
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

      return restaurantApi.post<{
        success: boolean;
        verification: IVerificationResponse;
        packingVerification: IPackingVerification | null;
      }>(`/order/verification/${orderId}/packing`, { image });
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
      return restaurantApi.put<{
        success: boolean;
        message: string;
        packingVerification: IPackingVerification | null;
      }>(`/order/verification/${orderId}/override`, { note });
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
      return restaurantApi.get<{
        success: boolean;
        verification: IPackingVerification | null;
        orderStatus: string;
      }>(`/order/verification/${orderId}`);
    },
    enabled: !!orderId,
    staleTime: 0,
  });
}

// ─── Rider: Submit Proof of Delivery ─────────────────────────
// POST /rider/order/pod — completes the delivery WITH the AI-verified
// drop-off photo attached. Returns the verdict for the confirmation UI.
// The order is implied server-side (the rider's own current delivery),
// so no orderId is sent.

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
          status: VerificationStatus;
          flag: string | null;
          confidence: number;
          notes: string | null;
          evidenceUrl: string | null;
          provider: string | null;
          deduped: boolean;
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
