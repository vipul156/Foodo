import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from "aws-lambda";
import jwt from "jsonwebtoken";
import { joinRoom, leaveRoom, removeConnection } from "./db.js";
import { broadcastToRoom } from "./broadcaster.js";

// Helper for APIGateway response
const ok = (): APIGatewayProxyResult => ({ statusCode: 200, body: "OK" });
const fail = (statusCode: number, msg: string): APIGatewayProxyResult => ({
  statusCode,
  body: msg,
});

// ─── 1. $connect (Handshake Authentication & Room Seeding) ────
export const handleConnect = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  context.callbackWaitsForEmptyEventLoop = false;
  const connectionId = event.requestContext.connectionId!;
  
  // Browsers pass token in Sec-WebSocket-Protocol or query param (?token=xyz)
  const token =
    event.queryStringParameters?.token ||
    event.headers?.["Sec-WebSocket-Protocol"] ||
    event.headers?.["Authorization"];

  if (!token) return fail(401, "Unauthorized: missing token");

  try {
    const cleanToken = token.replace(/^Bearer\s+/i, "");
    const decoded = jwt.verify(cleanToken, process.env.JWT_SECRET!) as any;
    const userData = decoded.user || decoded;
    const userId = userData._id || userData.sub || userData.id;

    if (!userId) return fail(401, "Invalid token payload");

    // Automatically join the user's private notification channel
    await joinRoom(connectionId, `user:${userId}`);

    // If seller/restaurant owner, join restaurant channel
    if (userData.restaurantId) {
      await joinRoom(connectionId, `restaurant:${userData.restaurantId}`);
    }

    return ok();
  } catch (err) {
    return fail(401, "Invalid token");
  }
};

// ─── 2. $disconnect (Connection Cleanup) ─────────────────────
export const handleDisconnect = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  context.callbackWaitsForEmptyEventLoop = false;
  const connectionId = event.requestContext.connectionId!;
  await removeConnection(connectionId);
  return ok();
};

// ─── 3. Default / Custom Actions Router ───────────────────────
export const handleDefault = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  context.callbackWaitsForEmptyEventLoop = false;
  const connectionId = event.requestContext.connectionId!;
  const domainName = event.requestContext.domainName!;
  const stage = event.requestContext.stage!;
  const endpoint = `https://${domainName}/${stage}`;

  if (!event.body) return ok();

  let message: { action: string; [key: string]: any };
  try {
    message = JSON.parse(event.body);
  } catch {
    return fail(400, "Invalid JSON");
  }

  switch (message.action) {
    case "order:track":
      if (message.orderId) {
        await joinRoom(connectionId, `order:${message.orderId}`);
      }
      break;

    case "order:untrack":
      if (message.orderId) {
        await leaveRoom(connectionId, `order:${message.orderId}`);
      }
      break;

    case "rider:location": {
      const { orderId, latitude, longitude } = message;
      if (
        orderId &&
        typeof latitude === "number" &&
        typeof longitude === "number"
      ) {
        await broadcastToRoom(endpoint, `order:${orderId}`, "rider:location", {
          orderId,
          latitude,
          longitude,
          at: Date.now(),
        });
      }
      break;
    }

    default:
      console.log(`Unknown action: ${message.action}`);
  }

  return ok();
};