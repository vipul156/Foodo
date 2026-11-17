import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { docClient, TABLE } from "@foodo/backend-common/aws";
import type {
  AgentStep,
  ArbitrationCase,
  ArbitrationChannel,
  ArbitrationStatus,
  DamageSeverity,
} from "../types.js";

// ─── Arbitration case repository (DynamoDB) ──────────────────
// Replaces the shared mongoose ArbitrationCase model.
//
//   PK: CASE#<caseId>   SK: CASE
//   GSI status-board : status  → createdAt  (admin review queue)
//   GSI order-index  : orderId → createdAt  (disputes for one order)
//
// Every write is a targeted UpdateItem — the case document is read
// once and then mutated field by field as the graph advances, exactly
// like the old $push/$set updates against Mongo.

const tableName = () => TABLE.arbitrationCases();
const pk = (caseId: string) => `CASE#${caseId}`;
const SK = "CASE";

export interface CreateCaseInput {
  caseId: string;
  orderId: string;
  customerId: string;
  complaint: string;
  channel: ArbitrationChannel;
  photoUrl: string | null;
  startedAt?: string;
}

export async function createCase(
  input: CreateCaseInput,
): Promise<ArbitrationCase> {
  const now = new Date().toISOString();
  const caseItem: ArbitrationCase = {
    caseId: input.caseId,
    orderId: input.orderId,
    customerId: input.customerId,
    complaint: input.complaint,
    channel: input.channel,
    photoUrl: input.photoUrl,
    status: "running",
    decision: null,
    decisionReason: null,
    refundAmount: null,
    voucherCode: null,
    damageSeverity: null,
    trustScore: null,
    telemetryFlags: [],
    steps: [],
    escalatedTo: null,
    escalatedAt: null,
    startedAt: input.startedAt ?? now,
    finishedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  await docClient().send(
    new PutCommand({
      TableName: tableName(),
      Item: { ...caseItem, pk: pk(input.caseId), sk: SK },
      // The caseId is the natural key — a second create for the same
      // id means two workers raced; the loser keeps the first row.
      ConditionExpression: "attribute_not_exists(pk)",
    }),
  );

  return caseItem;
}

export async function getCase(
  caseId: string,
): Promise<ArbitrationCase | null> {
  const result = await docClient().send(
    new GetCommand({
      TableName: tableName(),
      Key: { pk: pk(caseId), sk: SK },
    }),
  );
  return result.Item ? toCase(result.Item) : null;
}

/** Fields the graph mutates after the case row exists. */
export interface CaseUpdates {
  status?: ArbitrationStatus;
  decision?: string | null;
  decisionReason?: string | null;
  refundAmount?: number | null;
  voucherCode?: string | null;
  damageSeverity?: DamageSeverity | null;
  trustScore?: number | null;
  telemetryFlags?: string[];
  escalatedTo?: string | null;
  escalatedAt?: string | null;
  finishedAt?: string | null;
}

export async function updateCase(
  caseId: string,
  updates: CaseUpdates,
): Promise<void> {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets: string[] = [];

  let i = 0;
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    const nameKey = `#f${i}`;
    const valueKey = `:v${i}`;
    names[nameKey] = key;
    values[valueKey] = value;
    sets.push(`${nameKey} = ${valueKey}`);
    i += 1;
  }

  if (sets.length === 0) return;

  names["#updatedAt"] = "updatedAt";
  values[":now"] = new Date().toISOString();
  sets.push("#updatedAt = :now");

  await docClient().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: { pk: pk(caseId), sk: SK },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

/** Append one tool step to the thought graph. */
export async function appendStep(
  caseId: string,
  step: AgentStep,
): Promise<void> {
  await docClient().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: { pk: pk(caseId), sk: SK },
      UpdateExpression:
        "SET #steps = list_append(if_not_exists(#steps, :empty), :step), #updatedAt = :now",
      ExpressionAttributeNames: { "#steps": "steps", "#updatedAt": "updatedAt" },
      ExpressionAttributeValues: {
        ":empty": [],
        ":step": [step],
        ":now": new Date().toISOString(),
      },
    }),
  );
}

/** Admin review queue: escalated cases, newest first. */
export async function listEscalatedCases(
  limit = 25,
): Promise<ArbitrationCase[]> {
  const result = await docClient().send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: "status-board",
      KeyConditionExpression: "#status = :escalated",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":escalated": "escalated" },
      ScanIndexForward: false, // createdAt desc
      Limit: Math.min(100, Math.max(1, limit)),
    }),
  );
  return (result.Items ?? []).map(toCase);
}

/** Every dispute filed against one order (audit read). */
export async function listCasesByOrder(
  orderId: string,
  limit = 25,
): Promise<ArbitrationCase[]> {
  const result = await docClient().send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: "order-index",
      KeyConditionExpression: "orderId = :orderId",
      ExpressionAttributeValues: { ":orderId": orderId },
      ScanIndexForward: false, // createdAt desc
      Limit: Math.min(100, Math.max(1, limit)),
    }),
  );
  return (result.Items ?? []).map(toCase);
}

const toCase = (item: Record<string, any>): ArbitrationCase => ({
  caseId: String(item.caseId),
  orderId: String(item.orderId),
  customerId: String(item.customerId),
  complaint: String(item.complaint ?? ""),
  channel: (item.channel ?? "app") as ArbitrationChannel,
  photoUrl: item.photoUrl ?? null,
  status: (item.status ?? "running") as ArbitrationStatus,
  decision: item.decision ?? null,
  decisionReason: item.decisionReason ?? null,
  refundAmount: item.refundAmount ?? null,
  voucherCode: item.voucherCode ?? null,
  damageSeverity: item.damageSeverity ?? null,
  trustScore: item.trustScore ?? null,
  telemetryFlags: Array.isArray(item.telemetryFlags) ? item.telemetryFlags : [],
  steps: Array.isArray(item.steps) ? item.steps : [],
  escalatedTo: item.escalatedTo ?? null,
  escalatedAt: item.escalatedAt ?? null,
  startedAt: String(item.startedAt ?? item.createdAt ?? ""),
  finishedAt: item.finishedAt ?? null,
  createdAt: String(item.createdAt ?? ""),
  updatedAt: String(item.updatedAt ?? item.createdAt ?? ""),
});
