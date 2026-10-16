import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

// ─── Lambda HTTP adapter helpers ─────────────────────────────
// The API services run Express behind serverless-http (minimal churn,
// same routes/middlewares). These helpers only cover the non-Express
// entrypoints (SQS/SNS/EventBridge handlers) and the cookie/session
// quirks that change on API Gateway HTTP API.

/** Uniform Lambda response with CORS + JSON body. */
export function lambdaJson(
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

/**
 * Health check handler for API Gateway routes — Lambda has no uptime,
 * so the old process.uptime() is meaningless. Reports warm-start count
 * as a liveness proxy instead.
 */
const coldStart = Date.now();
let invocations = 0;

export function healthHandler(
  _event: APIGatewayProxyEvent,
): APIGatewayProxyResult {
  invocations++;
  return lambdaJson(200, {
    status: "UP",
    uptime: Math.round((Date.now() - coldStart) / 1000),
    invocations,
    timestamp: Date.now(),
  });
}

/**
 * Webhooks over API Gateway: providers send signed raw JSON, so the
 * event must reach the Express layer with exact bytes. API Gateway
 * HTTP APIs deliver body as a string — serverless-http + express.raw()
 * reconstructs it; base64 payloads are decoded first.
 */
export function normalizeWebhookBody(event: {
  body: string | null;
  isBase64Encoded?: boolean;
}): Buffer {
  if (!event.body) return Buffer.alloc(0);
  return event.isBase64Encoded
    ? Buffer.from(event.body, "base64")
    : Buffer.from(event.body, "utf8");
}
