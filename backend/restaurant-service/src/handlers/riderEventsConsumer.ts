import type { SNSEvent, SQSEvent } from "aws-lambda";
import { handlePushBatch } from "@foodo/backend-common/aws";
import { riderEventsHandler } from "../config/consumers.js";

// Rider/domain events arrive on a DIRECT SNS subscription (push, no
// queue to poll). `handlePushBatch` normalises the SNS envelope and
// re-throws a partial failure, because SNS retries on errors and ignores
// batchItemFailures — the subscription's redrive policy owns the DLQ.
export const handler = async (event: SNSEvent | SQSEvent) => {
  return handlePushBatch(event, riderEventsHandler);
};
