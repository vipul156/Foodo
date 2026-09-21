import { internalGet, getInternalHeaders } from "../config/http.js";
import { RefundLedger } from "../models/RefundLedger.js";

// ─── Tool: Customer LTV & trust score ────────────────────────
// Combines platform-side facts (order history from the restaurant
// service) with the agent's own ledger (dispute/refund history) into a
// single 0-1 trust score. The score does NOT make the decision — it
// bounds it: low trust caps autonomy regardless of evidence strength.

export interface TrustAssessment {
  score: number; // 0-1
  tier: "high" | "medium" | "low" | "new";
  ordersCompleted: number;
  lifetimeValue: number;
  disputesFiled: number;
  refundsReceived: number;
  refundRate: number; // refunds / orders (0 when no orders)
  signals: string[];
}

interface OrderHistory {
  count?: number;
  totalSpent?: number;
}

export const assessTrust = async (
  customerId: string,
  orderId: string,
): Promise<TrustAssessment> => {
  const signals: string[] = [];

  // Platform facts: completed orders + lifetime spend (restaurant service)
  let ordersCompleted = 0;
  let lifetimeValue = 0;
  try {
    const history = await internalGet<OrderHistory>(
      `${process.env.RESTAURANT_SERVICE_URL}/api/order/customer/${customerId}/history`,
      { headers: getInternalHeaders() },
    );
    ordersCompleted = clamp(history?.count ?? 0, 0, 1_000_000);
    lifetimeValue = clamp(history?.totalSpent ?? 0, 0, 100_000_000);
  } catch {
    signals.push("ORDER_HISTORY_UNAVAILABLE");
  }

  // Agent-side ledger: disputes + refunds already granted
  const ledger = await RefundLedger.findOne({ customerId });
  const disputesFiled = ledger?.disputeCount ?? 0;
  const refundsReceived = ledger?.refundCount ?? 0;

  const refundRate =
    ordersCompleted > 0 ? refundsReceived / ordersCompleted : refundsReceived > 0 ? 1 : 0;

  // ── Scoring (deterministic, explainable — no model here) ──
  let score = 0.5;

  if (ordersCompleted >= 20) {
    score += 0.2;
    signals.push("LOYAL_CUSTOMER");
  } else if (ordersCompleted >= 5) {
    score += 0.1;
  } else if (ordersCompleted === 0) {
    score -= 0.15;
    signals.push("NO_HISTORY");
  }

  if (lifetimeValue >= 10_000) {
    score += 0.1;
    signals.push("HIGH_LTV");
  }

  if (refundRate > 0.5 && ordersCompleted >= 3) {
    score -= 0.35;
    signals.push("CHRONIC_REFUNDER");
  } else if (refundRate > 0.25 && ordersCompleted >= 3) {
    score -= 0.2;
    signals.push("ELEVATED_REFUND_RATE");
  }

  if (disputesFiled >= 5 && refundsReceived / Math.max(1, disputesFiled) < 0.3) {
    score -= 0.2;
    signals.push("REPEATEDLY_REJECTED");
  }

  score = Math.min(1, Math.max(0, score));
  const tier = score >= 0.7 ? "high" : score >= 0.45 ? "medium" : ordersCompleted === 0 ? "new" : "low";

  return {
    score,
    tier,
    ordersCompleted,
    lifetimeValue,
    disputesFiled,
    refundsReceived,
    refundRate,
    signals,
  };
};

const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v));
