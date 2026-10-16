import type { SQSEvent, SQSBatchResponse } from "aws-lambda";
import { riderEventsHandler } from "../config/consumers.js";

export const handler = async (
  event: SQSEvent
): Promise<SQSBatchResponse | void> => {
  return riderEventsHandler(event);
};