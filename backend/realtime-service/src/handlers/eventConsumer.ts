import type { SNSEvent, SQSEvent, Context } from "aws-lambda";
import { toSqsShape } from "@foodo/backend-common/aws";
import { broadcastToRoom } from "../config/broadcaster.js";

const WS_ENDPOINT = process.env.WEBSOCKET_API_ENDPOINT!; // e.g., https://xyz.execute-api.ap-south-1.amazonaws.com/dev

// Triggered by a DIRECT SNS subscription (push, not poll): one
// notification per event, no queue to read. `toSqsShape` unwraps the SNS
// envelope so the body is the { event, room, payload } the publishers send.
export const handler = async (
  event: SNSEvent | SQSEvent,
  context: Context,
): Promise<void> => {
  context.callbackWaitsForEmptyEventLoop = false;

  for (const record of toSqsShape(event).Records) {
    try {
      const outer = JSON.parse(record.body);
      const envelope = outer.TopicArn ? JSON.parse(outer.Message) : outer;

      const { event: eventName, room, payload } = envelope;
      if (room && eventName) {
        await broadcastToRoom(WS_ENDPOINT, room, eventName, payload);
      }
    } catch (err) {
      console.error("Failed to broadcast event:", err);
    }
  }
};
