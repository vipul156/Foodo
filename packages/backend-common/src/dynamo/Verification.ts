import { randomUUID } from "crypto";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLE } from "../aws/dynamodb.js";

// ─── Verification verdict repository (DynamoDB) ──────────────
// Replaces the shared mongoose Verification model.
//
//   PK: VERIFICATION#<id>   SK: VERIFICATION
//   GSI order-index       : orderId      → createdAt  (audit read)
//   GSI restaurant-index  : restaurantId → createdAt  (fraud sweeps)
//   GSI rider-index       : riderId      → createdAt  (fraud sweeps)
//
// The AI verdict is ephemeral; the PHOTO is the legal record. Rows
// carry a TTL attribute so the table self-cleans after the evidence
// retention window (90 days by default — chargeback and dispute SLAs).
//
// The actor context (restaurant / rider / customer) is denormalized
// onto the row: support tooling reads verdicts standalone, with no
// joins across services.

export type VerificationType = "packing" | "delivery";
export type VerificationStatus = "verified" | "flagged" | "unverified";

export interface Verification {
  id: string;
  orderId: string;
  type: VerificationType;

  restaurantId: string | null;
  riderId: string | null;
  customerId: string | null;

  status: VerificationStatus;
  flag: string | null;
  confidence: number;
  detected: string[];
  missing: string[];
  unexpected: string[];
  notes: string | null;

  /** Which provider produced the verdict ("gemini" | "claude") — null when the chain was down. */
  provider: string | null;
  unverifiedReason: string | null;

  /** Cloudinary evidence copy — the durable dispute record. */
  image: { url: string | null; publicId: string | null };

  createdAt: string;
  updatedAt: string;
  /** Epoch seconds — DynamoDB TTL sweep. */
  ttl?: number;
}

export interface CreateVerificationInput {
  orderId: string;
  type: VerificationType;
  restaurantId?: string | null;
  riderId?: string | null;
  customerId?: string | null;
  status: VerificationStatus;
  flag?: string | null;
  confidence?: number;
  detected?: string[];
  missing?: string[];
  unexpected?: string[];
  notes?: string | null;
  provider?: string | null;
  unverifiedReason?: string | null;
  image?: { url: string | null; publicId: string | null };
  /** Retention window in days (default 90). */
  retentionDays?: number;
}

const tableName = () => TABLE.verifications();
const pk = (id: string) => `VERIFICATION#${id}`;
const SK = "VERIFICATION";

const DEFAULT_RETENTION_DAYS = 90;

export async function createVerification(
  input: CreateVerificationInput,
): Promise<Verification> {
  const now = new Date();
  const retentionDays = input.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const expiresAt = new Date(
    now.getTime() + retentionDays * 24 * 60 * 60 * 1000,
  );

  const verification: Verification = {
    id: randomUUID(),
    orderId: input.orderId,
    type: input.type,
    restaurantId: input.restaurantId ?? null,
    riderId: input.riderId ?? null,
    customerId: input.customerId ?? null,
    status: input.status,
    flag: input.flag ?? null,
    confidence: input.confidence ?? 0,
    detected: input.detected ?? [],
    missing: input.missing ?? [],
    unexpected: input.unexpected ?? [],
    notes: input.notes ?? null,
    provider: input.provider ?? null,
    unverifiedReason: input.unverifiedReason ?? null,
    image: input.image ?? { url: null, publicId: null },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ttl: Math.floor(expiresAt.getTime() / 1000),
  };

  await docClient().send(
    new PutCommand({
      TableName: tableName(),
      Item: { ...verification, pk: pk(verification.id), sk: SK },
    }),
  );

  return verification;
}

export async function getVerification(
  id: string,
): Promise<Verification | null> {
  const out = await docClient().send(
    new GetCommand({
      TableName: tableName(),
      Key: { pk: pk(id), sk: SK },
    }),
  );
  return out.Item ? toVerification(out.Item) : null;
}

/** Every verdict for one order, newest first. */
export async function listVerificationsByOrder(
  orderId: string,
  limit = 25,
): Promise<Verification[]> {
  const out = await docClient().send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: "order-index",
      KeyConditionExpression: "orderId = :orderId",
      ExpressionAttributeValues: { ":orderId": orderId },
      ScanIndexForward: false,
      Limit: Math.min(100, Math.max(1, limit)),
    }),
  );
  return (out.Items ?? []).map(toVerification);
}

/**
 * The most recent verdict of one type for an order, or null.
 *
 * This is the idempotency cooldown: a double-tap inside the window
 * returns the stored verdict instead of burning another AI call.
 */
export async function findRecentVerification(
  orderId: string,
  type: VerificationType,
  sinceMs: number,
): Promise<Verification | null> {
  const out = await docClient().send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: "order-index",
      KeyConditionExpression: "orderId = :orderId",
      ExpressionAttributeValues: { ":orderId": orderId },
      ScanIndexForward: false, // newest first
      Limit: 10,
    }),
  );

  const cutoff = Date.now() - sinceMs;
  const rows = (out.Items ?? []).map(toVerification);
  const match = rows.find(
    (v) => v.type === type && new Date(v.createdAt).getTime() >= cutoff,
  );
  return match ?? null;
}

/** Fraud sweep: a restaurant's flagged packing verdicts, newest first. */
export async function listVerificationsByRestaurant(
  restaurantId: string,
  limit = 50,
): Promise<Verification[]> {
  const out = await docClient().send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: "restaurant-index",
      KeyConditionExpression: "restaurantId = :restaurantId",
      ExpressionAttributeValues: { ":restaurantId": restaurantId },
      ScanIndexForward: false,
      Limit: Math.min(100, Math.max(1, limit)),
    }),
  );
  return (out.Items ?? []).map(toVerification);
}

/** Fraud sweep: a rider's flagged delivery verdicts, newest first. */
export async function listVerificationsByRider(
  riderId: string,
  limit = 50,
): Promise<Verification[]> {
  const out = await docClient().send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: "rider-index",
      KeyConditionExpression: "riderId = :riderId",
      ExpressionAttributeValues: { ":riderId": riderId },
      ScanIndexForward: false,
      Limit: Math.min(100, Math.max(1, limit)),
    }),
  );
  return (out.Items ?? []).map(toVerification);
}

const toVerification = (item: Record<string, any>): Verification => ({
  id: String(item.id),
  orderId: String(item.orderId ?? ""),
  type: (item.type ?? "packing") as VerificationType,
  restaurantId: item.restaurantId ?? null,
  riderId: item.riderId ?? null,
  customerId: item.customerId ?? null,
  status: (item.status ?? "unverified") as VerificationStatus,
  flag: item.flag ?? null,
  confidence: Number(item.confidence ?? 0),
  detected: Array.isArray(item.detected) ? item.detected : [],
  missing: Array.isArray(item.missing) ? item.missing : [],
  unexpected: Array.isArray(item.unexpected) ? item.unexpected : [],
  notes: item.notes ?? null,
  provider: item.provider ?? null,
  unverifiedReason: item.unverifiedReason ?? null,
  image: {
    url: item.image?.url ?? null,
    publicId: item.image?.publicId ?? null,
  },
  createdAt: String(item.createdAt ?? ""),
  updatedAt: String(item.updatedAt ?? item.createdAt ?? ""),
});
