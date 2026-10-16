import type { ScheduledEvent, Context } from "aws-lambda";
import { runPaymentReconciliation } from "../config/reconciliation.js";

export const handler = async (
  _event: ScheduledEvent,
  context: Context,
): Promise<{ audited: number }> => {
  context.callbackWaitsForEmptyEventLoop = false;
  return await runPaymentReconciliation();
};