import type { Store } from "express-rate-limit";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../aws/dynamodb.js";

// ─── DynamoDB fixed-window rate limiter ──────────────────────
// Replaces the Redis-backed limiter (rate-limit-redis) and the
// in-process memory store the old Express services used.
//
// Why DynamoDB and not the memory store: a Lambda execution environment
// is reused but NOT shared — the memory store gave every concurrent
// container its own counter, so "10 disputes/min" was really
// "10 disputes/min per container". DynamoDB gives one shared counter.
//
// Why DynamoDB and not Redis: the platform deliberately has no Redis.
// DynamoDB is the only data tier, and a rate-limit counter is a
// perfectly ordinary key/value row.
//
// Cost model: one GetItem + one conditional write per request. The
// counter row carries a TTL, so the table self-cleans.
//
// Failure posture: if DynamoDB is unreachable the limiter FAILS OPEN
// (allows the request). A rate limiter that takes down the packing
// gate is worse than a briefly-unlimited one — the internal-key gate
// and the gateway are the real access controls.

export interface DynamoRateLimitOptions {
  /** Table holding the counters (defaults to the AI-tier rate-limit table). */
  tableName?: string;
  /** Counter key prefix, e.g. "verification" — keeps namespaces apart. */
  prefix: string;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Maximum hits allowed inside one window. */
  limit: number;
}

interface CounterRow {
  pk: string;
  count: number;
  ttl: number;
}

/**
 * Build an express-rate-limit store backed by DynamoDB.
 *
 * The store is intentionally minimal: a fixed window starting at the
 * first hit of the window. `express-rate-limit` calls `increment` on
 * every request and reads `totalHits` from the result.
 */
export function createDynamoRateLimitStore(
  options: DynamoRateLimitOptions,
): Store {
  const tableName =
    options.tableName ?? process.env.RATE_LIMIT_TABLE ?? "foodo-rate-limits";
  const windowMs = options.windowMs;

  const windowKey = (key: string, now: number) => {
    const windowStart = Math.floor(now / windowMs) * windowMs;
    return {
      pk: `RL#${options.prefix}#${key}#${windowStart}`,
      windowStart,
    };
  };

  return {
    async init() {
      /* no-op: the counter table is provisioned in the foundation stack */
    },

    async increment(key: string) {
      const now = Date.now();
      const { pk, windowStart } = windowKey(key, now);
      const resetTime = new Date(windowStart + windowMs);
      const ttl = Math.floor((windowStart + windowMs) / 1000) + 60;

      try {
        // First hit of the window: create the counter.
        try {
          await docClient().send(
            new PutCommand({
              TableName: tableName,
              Item: { pk, count: 1, ttl } satisfies CounterRow,
              ConditionExpression: "attribute_not_exists(pk)",
            }),
          );
          return { totalHits: 1, resetTime };
        } catch (err) {
          if (!isConditionalCheckFailure(err)) throw err;
        }

        // Subsequent hits: increment, but refuse to go past the limit.
        // The condition makes the read-modify-write atomic — two
        // concurrent requests can't both slip past `limit`.
        const result = await docClient().send(
          new UpdateCommand({
            TableName: tableName,
            Key: { pk },
            UpdateExpression: "SET #count = #count + :one, #ttl = :ttl",
            ConditionExpression: "#count < :limit",
            ExpressionAttributeNames: { "#count": "count", "#ttl": "ttl" },
            ExpressionAttributeValues: {
              ":one": 1,
              ":limit": options.limit,
              ":ttl": ttl,
            },
            ReturnValues: "UPDATED_NEW",
          }),
        );

        const count = Number(result.Attributes?.count ?? 1);
        return { totalHits: count, resetTime };
      } catch (err) {
        if (isConditionalCheckFailure(err)) {
          // Over the limit: report the ceiling so the limiter 429s.
          return { totalHits: options.limit + 1, resetTime };
        }
        console.error(
          "[rate-limit] counter unavailable — failing open:",
          err instanceof Error ? err.message : err,
        );
        return { totalHits: 0, resetTime };
      }
    },

    async decrement() {
      // Not supported: a sliding-window decrement would need the full
      // hit list. Callers never decrement (no short-circuit penalties).
    },

    async resetKey(key: string) {
      const { pk } = windowKey(key, Date.now());
      await docClient().send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk },
          UpdateExpression: "SET #count = :zero",
          ExpressionAttributeNames: { "#count": "count" },
          ExpressionAttributeValues: { ":zero": 0 },
        }),
      );
    },
  };
}

const isConditionalCheckFailure = (err: unknown): boolean => {
  const name = (err as { name?: string } | undefined)?.name;
  return name === "ConditionalCheckFailedException";
};
