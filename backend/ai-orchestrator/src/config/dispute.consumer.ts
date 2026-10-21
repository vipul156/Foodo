import { handleSqsBatch } from "@foodo/backend-common/aws";
import { runArbitration } from "../graph/arbitration.graph.js";
import { generateCaseId } from "../graph/caseId.js";
import type { DisputeWorkItem } from "../types.js";

// ─── Dispute work-queue consumer (SQS) ───────────────────────
// Chat/email complaints arrive as work items on the disputes queue
// instead of the HTTP API. The SAME arbitration graph runs; outcomes
// are recorded identically.
//
// Retry + poison handling is the queue's job now: the SQS redrive
// policy (maxReceiveCount) moves a poison message to the DLQ, and
// the handler reports partial failures through batchItemFailures so
// only the failed records redrive.

export const disputeQueueHandler = async (event: any) =>
  handleSqsBatch(event, async (data: DisputeWorkItem) => {
    if (!data?.orderId || !data?.customerId || !data?.complaint) {
      // Malformed item — nothing to arbitrate. The record is dropped
      // (the batch reports success so it does not loop forever); the
      // payload is the audit trail.
      console.error("Dispute work item missing required fields — dropping");
      return;
    }

    await runArbitration({
      caseId: data.caseId ?? generateCaseId(),
      orderId: String(data.orderId),
      customerId: String(data.customerId),
      complaint: String(data.complaint),
      photoUrl: data.photoUrl ?? null,
      channel: data.channel ?? "email",
    });
  });
