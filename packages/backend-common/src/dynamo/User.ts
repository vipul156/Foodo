import { randomUUID, createHash } from "crypto";
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { docClient, TABLE } from "../aws/dynamodb.js";

// ─── User repository (DynamoDB) ──────────────────────────────
// Replaces the mongoose User model. Same domain shape, different keys:
//
//   PK: USER#<userId>          SK: PROFILE
//   PK: USER#<userId>          SK: REFRESH#<tokenHash>   (session rows)
//   GSI-1 (email-index):   PK=email     → user profile
//   GSI-2 (refresh-index): PK=tokenHash → refresh row
//
// Password hashing moves from the mongoose pre-save hook to explicit
// bcrypt calls in auth-service (DynamoDB has no schema hooks).
//
// Refresh tokens become their own SK rows instead of an embedded array:
// per-row TTL (DynamoDB auto-expiry), per-row revocation by UpdateItem,
// and no unbounded item growth — the Mongo embedded-array TTL caveat
// disappears entirely.

export interface RefreshTokenRow {
  pk: string; // USER#<userId>
  sk: string; // REFRESH#<tokenHash>
  tokenHash: string;
  createdAt: string;
  /** ISO timestamp; `ttl` is the DynamoDB TTL attribute (epoch sec). */
  expiresAt: string;
  ttl?: number;
  revokedAt: string | null;
  replacedByHash: string | null;
}

export interface DynamoUser {
  pk: string; // USER#<id>
  sk: string; // PROFILE
  id: string;
  name: string;
  email: string;
  password: string;
  role: string;
  image: string;
  createdAt: string;
  updatedAt: string;
}

export const userPk = (id: string) => `USER#${id}`;
export const PROFILE_SK = "PROFILE";

export const hashRefreshToken = (raw: string): string =>
  createHash("sha256").update(raw).digest("hex");

/** 96 hex chars of entropy — nothing guessable, nothing short. */
export const newRefreshTokenRaw = (): string =>
  randomUUID().replace(/-/g, "") +
  randomUUID().replace(/-/g, "") +
  randomUUID().replace(/-/g, "");

export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ─── Reads ───────────────────────────────────────────────────

export async function getUserById(id: string): Promise<DynamoUser | null> {
  const out = await docClient().send(
    new GetCommand({
      TableName: TABLE.users(),
      Key: { pk: userPk(id), sk: PROFILE_SK },
    }),
  );
  return (out.Item as DynamoUser | undefined) ?? null;
}

export async function getUserByEmail(
  email: string,
): Promise<DynamoUser | null> {
  const out = await docClient().send(
    new QueryCommand({
      TableName: TABLE.users(),
      IndexName: "email-index",
      KeyConditionExpression: "email = :email",
      ExpressionAttributeValues: { ":email": email.toLowerCase() },
      Limit: 1,
    }),
  );
  return (out.Items?.[0] as DynamoUser | undefined) ?? null;
}

/** Login path alias — the password lives on the profile item. */
export const getUserByEmailWithPassword = getUserByEmail;

/**
 * Refresh-token lookup: GSI on tokenHash, one query, no scan.
 * Returns the owning user plus the presented row.
 */
export async function getUserByRefreshTokenHash(tokenHash: string): Promise<{
  user: DynamoUser;
  row: RefreshTokenRow;
} | null> {
  const out = await docClient().send(
    new QueryCommand({
      TableName: TABLE.users(),
      IndexName: "refresh-index",
      KeyConditionExpression: "tokenHash = :h",
      ExpressionAttributeValues: { ":h": tokenHash },
      Limit: 1,
    }),
  );
  const row = out.Items?.[0] as
    | (RefreshTokenRow & { pk: string })
    | undefined;
  if (!row) return null;

  const userId = row.pk.split("#")[1]!;
  const user = await getUserById(userId);
  if (!user) return null;

  return {
    user,
    row: {
      pk: row.pk,
      sk: row.sk,
      tokenHash: row.tokenHash,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      replacedByHash: row.replacedByHash,
    },
  };
}

export async function listUsers(limit = 500): Promise<DynamoUser[]> {
  const out = await docClient().send(
    new ScanCommand({ TableName: TABLE.users(), Limit: limit }),
  );
  return (out.Items as DynamoUser[]) ?? [];
}

// ─── Writes ──────────────────────────────────────────────────

export async function createUser(input: {
  name: string;
  email: string;
  password: string;
  role: string;
  image: string;
}): Promise<DynamoUser> {
  const email = input.email.toLowerCase();

  // Email uniqueness: the email-index is not unique, so guard with a
  // query + conditional put on the profile key. The race window is
  // irrelevant at this scale; the duplicate check keeps double-clicks
  // from creating twin accounts.
  const existing = await getUserByEmail(email);
  if (existing) {
    const err = new Error("User already exists") as Error & { code?: string };
    err.code = "DuplicateUser";
    throw err;
  }

  const id = randomUUID();
  const now = new Date().toISOString();

  const item: DynamoUser = {
    pk: userPk(id),
    sk: PROFILE_SK,
    id,
    name: input.name,
    email,
    password: input.password, // caller hashes (bcrypt) before this call
    role: input.role,
    image: input.image,
    createdAt: now,
    updatedAt: now,
  };

  // The email-index projects email → profile, so the GSI query above is
  // the real duplicate guard; the condition catches the (unavoidable)
  // same-PK race only.
  await docClient().send(
    new PutCommand({
      TableName: TABLE.users(),
      Item: item,
      ConditionExpression: "attribute_not_exists(pk)",
    }),
  );
  return item;
}

/**
 * Grant a refresh-token session row. `ttl` makes DynamoDB sweep expired
 * rows automatically — the old $pull-on-access pruning disappears.
 */
export async function grantRefreshToken(
  userId: string,
  tokenHash: string,
  expiresAt: Date,
): Promise<void> {
  const expiresIso = expiresAt.toISOString();
  await docClient().send(
    new PutCommand({
      TableName: TABLE.users(),
      Item: {
        pk: userPk(userId),
        sk: `REFRESH#${tokenHash}`,
        tokenHash,
        createdAt: new Date().toISOString(),
        expiresAt: expiresIso,
        ttl: Math.floor(expiresAt.getTime() / 1000),
        revokedAt: null,
        replacedByHash: null,
      } satisfies RefreshTokenRow,
    }),
  );
}

/** Single-use rotation: revoke the presented row, link the next hash. */
export async function revokeRefreshToken(
  userId: string,
  tokenHash: string,
  replacedByHash: string | null,
): Promise<void> {
  await docClient().send(
    new UpdateCommand({
      TableName: TABLE.users(),
      Key: { pk: userPk(userId), sk: `REFRESH#${tokenHash}` },
      UpdateExpression:
        "SET revokedAt = :now, replacedByHash = :repl, updatedAt = :now",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: {
        ":now": new Date().toISOString(),
        ":repl": replacedByHash,
      },
    }),
  );
}

/** Reuse detection: revoke every still-active session of the user. */
export async function revokeAllActiveRefreshTokens(
  userId: string,
): Promise<void> {
  const out = await docClient().send(
    new QueryCommand({
      TableName: TABLE.users(),
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": userPk(userId),
        ":prefix": "REFRESH#",
      },
    }),
  );

  await Promise.all(
    (out.Items ?? [])
      .filter((r) => !(r as RefreshTokenRow).revokedAt)
      .map((r) =>
        revokeRefreshToken(userId, (r as RefreshTokenRow).tokenHash, null),
      ),
  );
}
