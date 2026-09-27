import type { SQSEvent, SQSBatchResponse, Context } from "aws-lambda";
import { riderEventsHandler } from "../config/consumers.js";

export const handler = async (
  event: SQSEvent,
  context: Context,
): Promise<SQSBatchResponse | void> => {
  context.callbackWaitsForEmptyEventLoop = false;
  return riderEventsHandler(event);
};