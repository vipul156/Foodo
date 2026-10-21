import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLE } from "../aws/dynamodb.js";

// ─── Admin review queue (DynamoDB) ───────────────────────────
// Human-in-the-loop parking lot. When the AI tier cannot decide
// autonomously (ambiguous evidence, low trust, provider refusal) it
// parks the case here and a human picks it up.
//
//   PK: REVIEW#<id>   SK: REVIEW
//   GSI status-board : status → createdAt
//
// The arbitration-cases table keeps the agent's reasoning trail;
// this table keeps the WORK ITEM (what a human must do next). The
// two are joined by the case id.

export type ReviewPriority = "low" | "normal" | "high";
export type ReviewStatus = "pending" | "resolved";

export interface ReviewItem {
  id: string;
  orderId: string | null;
  customerId: string | null;
  type: string;
  summary: string;
  priority: ReviewPriority;
  status: ReviewStatus;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export interface CreateReviewItemInput {
  id: string;
  orderId?: string | null;
  customerId?: string | null;
  type: string;
  summary: string;
  priority?: ReviewPriority;
}

const tableName = () => TABLE.reviewQueue();
const pk = (id: string) => `REVIEW#${id}`;
const SK = "REVIEW";

export async function createReviewItem(
  input: CreateReviewItemInput,
): Promise<ReviewItem> {
  const now = new Date().toISOString();
  const item: ReviewItem = {
    id: input.id,
    orderId: input.orderId ?? null,
    customerId: input.customerId ?? null,
    type: input.type,
    summary: input.summary,
    priority: input.priority ?? "normal",
    status: "pending",
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    resolvedBy: null,
  };

  await docClient().send(
    new PutCommand({
      TableName: tableName(),
      Item: { ...item, pk: pk(input.id), sk: SK },
      // Idempotent: the agent may park the same case twice (retry
      // after a partial failure). The first write wins.
      ConditionExpression: "attribute_not_exists(pk)",
    }),
  );

  return item;
}

export async function getReviewItem(id: string): Promise<ReviewItem | null> {
  const out = await docClient().send(
    new GetCommand({
      TableName: tableName(),
      Key: { pk: pk(id), sk: SK },
    }),
  );
  return out.Item ? toReviewItem(out.Item) : null;
}

/** Pending items, newest first. */
export async function listPendingReviewItems(
  limit = 50,
): Promise<ReviewItem[]> {
  const out = await docClient().send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: "status-board",
      KeyConditionExpression: "#status = :pending",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":pending": "pending" },
      ScanIndexForward: false,
      Limit: Math.min(100, Math.max(1, limit)),
    }),
  );
  return (out.Items ?? []).map(toReviewItem);
}

export async function resolveReviewItem(
  id: string,
  resolvedBy: string,
): Promise<ReviewItem | null> {
  const now = new Date().toISOString();
  const out = await docClient()
    .send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { pk: pk(id), sk: SK },
        UpdateExpression:
          "SET #status = :resolved, resolvedAt = :now, resolvedBy = :by, updatedAt = :now",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":resolved": "resolved",
          ":now": now,
          ":by": resolvedBy,
        },
        ReturnValues: "ALL_NEW",
      }),
    )
    .catch(() => null);
  return out?.Attributes ? toReviewItem(out.Attributes) : null;
}

const toReviewItem = (item: Record<string, any>): ReviewItem => ({
  id: String(item.id),
  orderId: item.orderId ?? null,
  customerId: item.customerId ?? null,
  type: String(item.type ?? "refund_arbitration"),
  summary: String(item.summary ?? ""),
  priority: (item.priority ?? "normal") as ReviewPriority,
  status: (item.status ?? "pending") as ReviewStatus,
  createdAt: String(item.createdAt ?? ""),
  updatedAt: String(item.updatedAt ?? item.createdAt ?? ""),
  resolvedAt: item.resolvedAt ?? null,
  resolvedBy: item.resolvedBy ?? null,
});
