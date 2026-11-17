import type { Context, SNSEvent, SQSEvent } from "aws-lambda";
import { handlePushBatch, type SqsBatchResult } from "@foodo/backend-common/aws";
import { riderEventsHandler } from "../config/consumers.js";

// Saga compensations arrive on a DIRECT SNS subscription (push, no queue
// to poll). `handlePushBatch` normalises the SNS envelope and re-throws a
// partial failure, because SNS retries on errors and ignores
// batchItemFailures — the subscription's redrive policy owns the DLQ.
export const handler = async (
  event: SNSEvent | SQSEvent,
  context: Context,
): Promise<SqsBatchResult | void> => {
  context.callbackWaitsForEmptyEventLoop = false;
  return handlePushBatch(event, riderEventsHandler);
};
