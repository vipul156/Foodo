import type { SQSEvent, SQSBatchResponse, Context } from "aws-lambda";
import { paymentQueueHandler } from "../config/consumers.js";

export const handler = async (
  event: SQSEvent
): Promise<SQSBatchResponse | void> => {
  return paymentQueueHandler(event);
};