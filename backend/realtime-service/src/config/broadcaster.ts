import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  GoneException,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { getConnectionsInRoom, removeConnection } from "./db.js";

let client: ApiGatewayManagementApiClient;

const getApiClient = (endpoint: string) => {
  if (!client) {
    client = new ApiGatewayManagementApiClient({
      endpoint, // format: https://{api-id}.execute-api.{region}.amazonaws.com/{stage}
    });
  }
  return client;
};

export const broadcastToRoom = async (
  endpoint: string,
  room: string,
  event: string,
  payload: unknown,
) => {
  const connectionIds = await getConnectionsInRoom(room);
  if (!connectionIds.length) return;

  const apiClient = getApiClient(endpoint);
  const data = Buffer.from(JSON.stringify({ event, payload }));

  await Promise.allSettled(
    connectionIds.map(async (connectionId) => {
      try {
        await apiClient.send(
          new PostToConnectionCommand({
            ConnectionId: connectionId,
            Data: data,
          }),
        );
      } catch (err: any) {
        // If client closed browser without clean disconnect, AWS throws GoneException (410)
        if (err instanceof GoneException || err.$metadata?.httpStatusCode === 410) {
          await removeConnection(connectionId);
        } else {
          console.error(`Failed to send to ${connectionId}:`, err);
        }
      }
    }),
  );
};