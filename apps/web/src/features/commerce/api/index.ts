// ============================================================
// Foodo — Conversational Commerce: TanStack Query API Hooks
// ============================================================
// Contract owner: backend/ai-commerce (FastAPI). Payloads are
// snake_case on the wire — these types mirror the service exactly
// rather than renaming fields at the boundary.
//
// The agent NEVER places an order. It mutates its own draft; the
// customer confirms, we materialise the draft into the platform
// cart, and payment happens in the existing /checkout flow.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { restaurantApi } from "@/lib/api-client";

// ─── Wire types ──────────────────────────────────────────────

export interface CommerceLineItem {
  item_id: string;
  name: string;
  unit_price: number;
  quantity: number;
  customizations: string[];
  from_history?: boolean;
  match_score?: number | null;
}

export interface CommercePricing {
  subtotal: number;
  delivery_fee: number;
  platform_fee: number;
  total: number;
  currency: string;
}

/** Full draft state — `GET /api/commerce/draft` and turn responses. */
export interface CommerceDraft {
  session_id: string;
  restaurant_id: string | null;
  restaurant_name: string | null;
  lines: CommerceLineItem[];
  /** Present once the agent has called draft_finalize. */
  pricing: CommercePricing | null;
  budget_cap: number | null;
  budget_note: string | null;
  ready_to_pay: boolean;
  requires_auth: boolean;
  turn_count: number;
}

/** The card the UI renders — `GET /api/commerce/summary`. */
export interface CommerceCheckoutCard {
  restaurant_id: string;
  restaurant_name: string;
  lines: CommerceLineItem[];
  pricing: CommercePricing;
  requires_auth: boolean;
  ready_to_pay: boolean;
  messages: string[];
}

export interface CommerceToolStep {
  node?: string;
  type?: string;
  tool?: string;
  ok?: boolean;
  error?: string | null;
  duration_ms?: number;
}

export interface CommerceTurnResponse {
  session_id: string;
  reply: string;
  draft: CommerceDraft;
  checkout_card: CommerceCheckoutCard | null;
  tool_trace: CommerceToolStep[];
}

export interface CommerceSessionSummary {
  session_id: string;
  updated_at: string | null;
  has_draft: boolean;
}

export interface ResumedConversation {
  sessionId: string;
  draft: CommerceDraft;
  card: CommerceCheckoutCard | null;
}

// ─── POST /api/commerce/turn ─────────────────────────────────
// One conversation turn. Mutates the DRAFT only.

export function useCommerceTurn() {
  return useMutation({
    mutationFn: (vars: { message: string; sessionId: string | null }) =>
      restaurantApi.post<CommerceTurnResponse>("/commerce/turn", {
        message: vars.message,
        // Omitted entirely for a new conversation — the service then
        // mints the session and returns its id.
        ...(vars.sessionId ? { session_id: vars.sessionId } : {}),
      }),
  });
}

// ─── GET /api/commerce/sessions ──────────────────────────────
// Active conversations (last 10) so a customer can pick one back
// up after closing the tab. The service stores message history but
// does not expose it; resuming restores the draft + card only.

export function useCommerceSessions(enabled: boolean) {
  return useQuery({
    queryKey: ["commerce", "sessions"],
    queryFn: () =>
      restaurantApi.get<{ success: boolean; sessions: CommerceSessionSummary[] }>(
        "/commerce/sessions",
      ),
    enabled,
    staleTime: 1000 * 30,
    retry: false,
  });
}

// ─── Resume: draft + summary in one action ───────────────────
// /draft carries the budget context; /summary carries the priced
// card. A 409 on /summary means the draft is empty — a valid state,
// not an error, so it is tolerated here.

export function useResumeConversation() {
  return useMutation({
    mutationFn: async (sessionId: string): Promise<ResumedConversation> => {
      const draftResponse = await restaurantApi.get<{
        success: boolean;
        draft: CommerceDraft;
      }>("/commerce/draft", { params: { session_id: sessionId } });

      let card: CommerceCheckoutCard | null = null;
      try {
        card = await restaurantApi.get<CommerceCheckoutCard>("/commerce/summary", {
          params: { session_id: sessionId },
        });
      } catch {
        // 409 = empty draft. Nothing to render yet.
        card = null;
      }

      return {
        sessionId,
        draft: draftResponse.draft,
        card,
      };
    },
  });
}

// ─── DELETE /api/commerce/session ────────────────────────────
// Abandons a conversation server-side (TTL would clean it up, this
// is the explicit version).

export function useDiscardConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (sessionId: string) =>
      restaurantApi.delete<{ success: boolean }>("/commerce/session", {
        params: { session_id: sessionId },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["commerce", "sessions"] });
    },
  });
}

// ─── Confirmed hand-off: draft → real cart ───────────────────
// Everything below this line is the customer's explicit action.
// The cart is replaced (the platform allows one restaurant per
// cart), then each draft line is added. On any failure the cart is
// cleared again so the customer is never left half-built.

export interface MaterializeVars {
  card: CommerceCheckoutCard;
  onProgress?: (done: number, total: number) => void;
}

export function useMaterializeDraft() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ card, onProgress }: MaterializeVars) => {
      const total = card.lines.reduce((sum, line) => sum + line.quantity, 0);
      let done = 0;

      await restaurantApi.delete("/cart/clear");
      onProgress?.(0, total);

      try {
        for (const line of card.lines) {
          // /cart/add increments by one; quantity is replayed.
          for (let i = 0; i < line.quantity; i += 1) {
            await restaurantApi.post("/cart/add", {
              restaurantId: card.restaurant_id,
              itemId: line.item_id,
            });
            done += 1;
            onProgress?.(done, total);
          }
        }
      } catch {
        // Roll back rather than hand the customer a partial cart.
        await restaurantApi.delete("/cart/clear").catch(() => undefined);
        throw new Error(
          "One of these dishes could not be added — the menu may have changed. Ask for an alternative.",
        );
      }

      return { units: done, lines: card.lines.length };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cart"] });
    },
  });
}
