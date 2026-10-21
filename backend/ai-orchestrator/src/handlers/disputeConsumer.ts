import type { SQSEvent, SQSBatchResponse } from "aws-lambda";
import { disputeQueueHandler } from "../config/dispute.consumer.js";

// Lambda SQS entrypoint — the sole runtime of the arbitration graph.
// Intake (HTTP + other channels) only enqueues; this consumer Lambda
// runs the graph, so a completed HTTP response can never freeze
// in-flight background work (the old fire-and-forget promise).
export const handler = async (event: SQSEvent): Promise<SQSBatchResponse | void> => {
  return disputeQueueHandler(event);
};
