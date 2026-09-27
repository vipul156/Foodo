import {
  PutCommand,
  DeleteCommand,
  QueryCommand,
  BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { docClient } from "@foodo/backend-common/aws";

const TABLE_NAME = process.env.CONNECTIONS_TABLE_NAME!;

// 1. Join a room (user:id, restaurant:id, order:id)
export const joinRoom = async (connectionId: string, room: string) => {
  const ttl = Math.floor(Date.now() / 1000) + 24 * 60 * 60; // 24-hour safety TTL
  await docClient().send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { connectionId, room, ttl },
    }),
  );
};

// 2. Leave a room
export const leaveRoom = async (connectionId: string, room: string) => {
  await docClient().send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { connectionId, room },
    }),
  );
};

// 3. Find all connections in a room
export const getConnectionsInRoom = async (room: string): Promise<string[]> => {
  const res = await docClient().send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: "room-index",
      KeyConditionExpression: "room = :room",
      ExpressionAttributeValues: { ":room": room },
      ProjectionExpression: "connectionId",
    }),
  );
  return (res.Items ?? []).map((item) => item.connectionId as string);
};

// 4. Remove all rooms for a disconnected connection
export const removeConnection = async (connectionId: string) => {
  const res = await docClient().send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "connectionId = :cid",
      ExpressionAttributeValues: { ":cid": connectionId },
    }),
  );

  if (!res.Items?.length) return;

  const deleteRequests = res.Items.map((item) => ({
    DeleteRequest: {
      Key: { connectionId: item.connectionId, room: item.room },
    },
  }));

  await docClient().send(
    new BatchWriteCommand({
      RequestItems: {
        [TABLE_NAME]: deleteRequests,
      },
    }),
  );
};