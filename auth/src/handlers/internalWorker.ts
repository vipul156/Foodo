// src/handlers/internalWorker.ts
import connectDB from "../config/db.js";
import { listUsers, getUserStats } from "../controllers/internal.js";

export const handler = async (event: { action: string; payload?: any }, context: any) => {
  context.callbackWaitsForEmptyEventLoop = false;
  await connectDB();

  switch (event.action) {
    case "LIST_USERS":
      return await listUsers(event.payload);

    case "GET_USER_STATS":
      return await getUserStats();

    default:
      throw new Error(`Unsupported internal action: ${event.action}`);
  }
};