import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLE } from "@foodo/backend-common/aws";

// ─── Refund ledger (DynamoDB) ─────────────────────────────────
// Replaces the shared mongoose RefundLedger model.
//
//   PK: CUSTOMER#<customerId>   SK: LEDGER
//
// One row per customer: cumulative refund totals + dispute counts.
// Feeds the trust score (dispute rate) and gives fraud tooling a
// single-query view of a customer's refund history. The payment
// provider remains the source of truth for actual money movement;
// this ledger is the agent's bounded memory.
//
// The counters are incremented with DynamoDB's ADD — no read-modify-
// write, so two concurrent cases can't lose an increment.

const tableName = () => TABLE.refundLedger();
const pk = (customerId: string) => `CUSTOMER#${customerId}`;
const SK = "LEDGER";

export interface RefundLedger {
  customerId: string;
  totalRefunded: number;
  refundCount: number;
  disputeCount: number;
  escalatedCount: number;
  lastRefundAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerIncrements {
  totalRefunded?: number;
  refundCount?: number;
  disputeCount?: number;
  escalatedCount?: number;
}

export async function getLedger(
  customerId: string,
): Promise<RefundLedger | null> {
  const result = await docClient().send(
    new GetCommand({
      TableName: tableName(),
      Key: { pk: pk(customerId), sk: SK },
    }),
  );
  return result.Item ? toLedger(result.Item) : null;
}

/**
 * Add to the customer's counters, creating the row on first write.
 *
 * `ADD` is atomic per attribute, so parallel disputes on the same
 * customer both land. `if_not_exists` keeps the original createdAt.
 */
export async function incrementLedger(
  customerId: string,
  increments: LedgerIncrements,
  options: { touchRefundAt?: boolean } = {},
): Promise<void> {
  const adds: string[] = [];
  const values: Record<string, unknown> = {};
  const names: Record<string, string> = {};

  const counterMap: Array<[keyof LedgerIncrements, string]> = [
    ["totalRefunded", "totalRefunded"],
    ["refundCount", "refundCount"],
    ["disputeCount", "disputeCount"],
    ["escalatedCount", "escalatedCount"],
  ];

  let i = 0;
  for (const [key, attribute] of counterMap) {
    const delta = increments[key];
    if (!delta) continue;
    const nameKey = `#c${i}`;
    const valueKey = `:c${i}`;
    names[nameKey] = attribute;
    values[valueKey] = delta;
    adds.push(`${nameKey} ${valueKey}`);
    i += 1;
  }

  const now = new Date().toISOString();
  const sets = ["#customerId = :customerId", "#createdAt = if_not_exists(#createdAt, :now)", "#updatedAt = :now"];
  names["#customerId"] = "customerId";
  names["#createdAt"] = "createdAt";
  names["#updatedAt"] = "updatedAt";
  values[":customerId"] = customerId;
  values[":now"] = now;

  if (options.touchRefundAt) {
    sets.push("#lastRefundAt = :now");
    names["#lastRefundAt"] = "lastRefundAt";
  }

  // DynamoDB's UpdateExpression grammar fixes the clause order:
  // SET → REMOVE → ADD → DELETE.
  const expression = [
    `SET ${sets.join(", ")}`,
    adds.length ? `ADD ${adds.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  await docClient().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: { pk: pk(customerId), sk: SK },
      UpdateExpression: expression,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

const toLedger = (item: Record<string, any>): RefundLedger => ({
  customerId: String(item.customerId),
  totalRefunded: Number(item.totalRefunded ?? 0),
  refundCount: Number(item.refundCount ?? 0),
  disputeCount: Number(item.disputeCount ?? 0),
  escalatedCount: Number(item.escalatedCount ?? 0),
  lastRefundAt: item.lastRefundAt ?? null,
  createdAt: String(item.createdAt ?? ""),
  updatedAt: String(item.updatedAt ?? item.createdAt ?? ""),
});
