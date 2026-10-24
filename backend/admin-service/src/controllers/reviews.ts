import { tryCatchStatus, type AuthRequest } from "@foodo/backend-common";
import {
  listPendingReviewItems,
  resolveReviewItem,
} from "@foodo/backend-common/dynamo";
import type { Request, Response } from "express";

// ─── Human review queue (AI escalation parking lot) ─────────
// When the AI arbitration agent can't decide on its own — ambiguous
// photo evidence, a low trust score, a suspicious delivery trail, or a
// refund the payment service refused — it parks the case here with a
// written brief and the evidence digest.
//
// The queue is a table, not a service call: admin-service already holds
// table-level access to the shared data plane, so the work list is one
// query. The agent's own reasoning trail lives in the arbitration-cases
// table (ai-orchestrator); the case id joins the two.

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Gateway claims carry `sub` (normalized to `id`), not the profile email. */
const firstString = (...values: unknown[]): string | null => {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
};

export const getPendingReviews = tryCatchStatus(async (req: Request, res: Response) => {
  const rawLimit = req.query.limit;
  const limit = Math.min(
    100,
    Math.max(1, Number(Array.isArray(rawLimit) ? rawLimit[0] : rawLimit) || 50),
  );

  const items = await listPendingReviewItems(limit);

  return res.json({ count: items.length, items });
});

// ─── Mark handled ───────────────────────────────────────────
// Resolving here records WHO closed the work item. The money move
// itself (the manual refund or voucher) happens against the payment
// provider; this is the queue's bookkeeping, so it stays idempotent —
// a second resolve returns the item unchanged rather than erroring.

export const resolveReview = tryCatchStatus(async (req: Request, res: Response) => {
  const { id } = req.params;

  if (typeof id !== "string" || !id) {
    throw new HttpError(400, "Invalid id");
  }

  // The session identity is the audit trail: who closed this work item.
  const actor = req as AuthRequest;
  const resolvedBy = firstString(actor.user?.email, actor.user?.id) ?? "admin";

  const item = await resolveReviewItem(id, resolvedBy);

  if (!item) {
    throw new HttpError(404, "Review item not found");
  }

  return res.json({ message: "Review item resolved", item });
});
