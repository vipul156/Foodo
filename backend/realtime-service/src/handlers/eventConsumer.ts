import type { SQSEvent, Context } from "aws-lambda";
import { broadcastToRoom } from "../config/broadcaster.js";

const WS_ENDPOINT = process.env.WEBSOCKET_API_ENDPOINT!; // e.g., https://xyz.execute-api.ap-south-1.amazonaws.com/dev

export const handler = async (event: SQSEvent, context: Context): Promise<void> => {
  context.callbackWaitsForEmptyEventLoop = false;

  for (const record of event.Records) {
    try {
      const outer = JSON.parse(record.body);
      const envelope = outer.TopicArn ? JSON.parse(outer.Message) : outer;

      const { event: eventName, room, payload } = envelope;
      if (room && eventName) {
        await broadcastToRoom(WS_ENDPOINT, room, eventName, payload);
      }
    } catch (err) {
      console.error("Failed to broadcast SQS event:", err);
    }
  }
};