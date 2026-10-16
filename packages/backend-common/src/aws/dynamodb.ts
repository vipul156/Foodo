import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

// ─── Shared DynamoDB document client ─────────────────────────
// One client per Lambda container, created lazily on first use and
// reused across warm invocations (the SDK's connection pool lives on
// the client). Never construct per-request clients — that is the #1
// Lambda performance mistake.
//
// Region comes from AWS_REGION (set automatically by Lambda); override
// locally with AWS_DYNAMO_ENDPOINT (e.g. dynamodb-local / moto).

let client: DynamoDBDocumentClient | undefined;

export const docClient = (): DynamoDBDocumentClient => {
  if (client) return client;

  const base = new DynamoDBClient({
    ...(process.env.AWS_DYNAMO_ENDPOINT && {
      endpoint: process.env.AWS_DYNAMO_ENDPOINT,
    }),
    maxAttempts: 3,
  });

  client = DynamoDBDocumentClient.from(base, {
    marshallOptions: {
      removeUndefinedValues: true, // sparse attributes stay sparse
      convertClassInstanceToMap: true,
    },
  });

  return client;
};

/** Table names resolve from env (IaC injects them per-service later). */
export const table = (envVar: string, fallback: string): string =>
  process.env[envVar] ?? fallback;

export const TABLE = {
  users: () => table("USERS_TABLE", "foodo-users"),
  restaurants: () => table("RESTAURANTS_TABLE", "foodo-restaurants"),
  riders: () => table("RIDERS_TABLE", "foodo-riders"),
  orders: () => table("ORDERS_TABLE", "foodo-orders"),
  menuItems: () => table("MENU_ITEMS_TABLE", "foodo-menu-items"),
  carts: () => table("CARTS_TABLE", "foodo-carts"),
  addresses: () => table("ADDRESSES_TABLE", "foodo-addresses"),
  webhookDedupe: () => table("WEBHOOK_DEDUPE_TABLE", "foodo-webhook-dedupe"),
} as const;
