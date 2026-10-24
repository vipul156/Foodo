// ============================================================
// Foodo — Disputes Feature: TanStack Query API Hooks
// ============================================================
// Three doors onto the AI arbitration tier:
//   POST  /api/agent/dispute              file a case (customer, 202 + caseId)
//   GET   /api/agent/order/:id/cases      cases for one order (customer)
//   GET   /api/admin/reviews              the human work list (admin)
//
// The agent's own vocabulary (case, steps, damage severity) lives here
// rather than in @/types: no other surface speaks it.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { adminApi, restaurantApi } from "@/lib/api-client";

export type DisputeStatus =
  | "running"
  | "auto_refunded"
  | "voucher_issued"
  | "escalated"
  | "rejected"
  | "failed";

export type DamageSeverity = "none" | "minor" | "major" | "destroyed" | "unclear";

/** One tool call in the agent's thought graph — the case's audit trail. */
export interface DisputeStep {
  tool: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  at: string;
  durationMs: number;
  tokens?: { prompt: number; completion: number };
}

export interface DisputeCase {
  caseId: string;
  orderId: string;
  customerId: string;
  complaint: string;
  channel: "chat" | "email" | "app";
  photoUrl: string | null;
  status: DisputeStatus;
  decision: string | null;
  decisionReason: string | null;
  refundAmount: number | null;
  voucherCode: string | null;
  damageSeverity: DamageSeverity | null;
  trustScore: number | null;
  telemetryFlags: string[];
  steps: DisputeStep[];
  escalatedTo: string | null;
  escalatedAt: string | null;
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Statuses where the graph has stopped — polling can stop too. */
export function isSettled(status: DisputeStatus | undefined): boolean {
  return Boolean(status) && status !== "running";
}

// ─── Customer: File a Dispute ────────────────────────────────
// The photo is pre-downscaled to a JPEG data URI by the caller (same
// capture pipeline as delivery verification) — the service uploads it
// to the evidence store before enqueueing.

export interface FileDisputeInput {
  orderId: string;
  customerId: string;
  complaint: string;
  image?: string;
}

export function useFileDispute() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ orderId, customerId, complaint, image }: FileDisputeInput) => {
      return restaurantApi.post<{ success: boolean; caseId: string; message: string }>(
        "/agent/dispute",
        {
          orderId,
          customerId,
          complaint,
          // Channel is how the complaint reached us; this surface is the app.
          channel: "app",
          ...(image ? { image } : {}),
        },
      );
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["disputes", "order", variables.orderId] });
    },
  });
}

// ─── Customer: Cases for One Order ───────────────────────────
// The graph runs off an SQS consumer, so the case row appears a moment
// after intake and settles later. Keying the read on the order (not a
// case id the browser has to keep) means the order page always finds
// its case, on any device.
//
// `shouldPoll` keeps the interval alive while a case is queued but not
// yet written — the gap between the 202 and the consumer's first write.
// It receives the current rows, so the caller never has to mirror state.

export function useOrderDisputes(
  orderId: string,
  shouldPoll?: (cases: DisputeCase[]) => boolean,
) {
  return useQuery({
    queryKey: ["disputes", "order", orderId],
    queryFn: async () => {
      const res = await restaurantApi.get<{
        success: boolean;
        count: number;
        cases: DisputeCase[];
      }>(`/agent/order/${orderId}/cases`);
      return res.cases;
    },
    enabled: Boolean(orderId),
    refetchInterval: (query) => {
      const cases = (query.state.data as DisputeCase[] | undefined) ?? [];
      if (shouldPoll?.(cases)) return 4000;
      return cases.some((c) => c.status === "running") ? 4000 : false;
    },
    staleTime: 0,
  });
}

// ─── Admin: Escalation Review Queue ─────────────────────────
// GET /admin/reviews — the one work list behind every AI escalation.
// The agent parks what it cannot settle alone here with a written
// brief (complaint, vision triage, trust score, delivery flags and
// its own recommendation), so the reviewer never opens a second app.

export type ReviewPriority = "low" | "normal" | "high";

export interface ReviewItem {
  id: string;
  orderId: string | null;
  customerId: string | null;
  type: string;
  summary: string;
  /**
   * Cloudinary URL of the customer's evidence photo — the proof the
   * reviewer has to see to decide. Null means the claim arrived with no
   * photo, OR the item was parked before the queue carried the URL; the
   * panel tells those apart via `useCaseEvidence`.
   */
  photoUrl: string | null;
  priority: ReviewPriority;
  status: "pending" | "resolved";
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

// ─── Admin: Evidence fallback ────────────────────────────────
// The work item is the queue's record; the case row is the agent's. Items
// parked before the queue carried `photoUrl` still have their photo on
// the case (same id), so one conditional read keeps old items reviewable
// without a data backfill.

export function useCaseEvidence(caseId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["disputes", "case", caseId],
    queryFn: async () => {
      const res = await restaurantApi.get<{ success: boolean; case: DisputeCase }>(
        `/agent/case/${caseId}`,
      );
      return res.case;
    },
    enabled: enabled && Boolean(caseId),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function usePendingReviews(limit = 50) {
  return useQuery({
    queryKey: ["reviews", "pending", limit],
    queryFn: async () => {
      const res = await adminApi.get<{ count: number; items: ReviewItem[] }>("/reviews", {
        params: { limit },
      });
      return res.items;
    },
    refetchInterval: 20_000,
    staleTime: 0,
  });
}

// PATCH /admin/reviews/:id/resolve — bookkeeping only: it records who
// closed the item. The money move itself happens at the payment
// provider, which is why this takes no amount and no decision.
export function useResolveReview() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      return adminApi.patch<{ message: string; item: ReviewItem }>(
        `/reviews/${id}/resolve`,
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reviews", "pending"] });
    },
  });
}
