import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";
import {
  handleConnect,
  handleDisconnect,
  handleDefault,
} from "../config/websocket.js";

// ─── Single Lambda behind all three WebSocket routes ─────────
// One function keeps the connection registry hot across the
// connect/disconnect/default lifecycle of a client session.
// (WebSocket API events are APIGatewayProxyEvent-shaped.)

export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  context.callbackWaitsForEmptyEventLoop = false;

  switch (event.requestContext.routeKey) {
    case "$connect":
      return handleConnect(event, context);
    case "$disconnect":
      return handleDisconnect(event, context);
    default:
      return handleDefault(event, context);
  }
};
