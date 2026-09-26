import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from "ioredis";
import { getIo } from "../socket.js";

// ─── Socket.IO Redis adapter ────────────────────────────────
// Rooms live in each process's memory, so with N realtime replicas a
// client connected to replica A never receives events emitted by
// replica B. The adapter fixes this by relaying every io.to(room).emit
// through Redis pub/sub, which every replica subscribes to — the room
// namespace becomes cluster-wide.
//
// REDIS_URL is optional on purpose: a single realtime node works fine
// without it (no cross-replica traffic exists), so the service degrades
// to single-node mode with a loud warning instead of failing to boot.
export const connectRedisAdapter = async (): Promise<void> => {
  const redisUrl = process.env.REDIS_URL;
  const io = getIo();

  if (!redisUrl) {
    console.warn(
      "[Realtime] REDIS_URL not set — running in single-node mode. " +
        "Rooms are in-memory: with more than one replica, users connected " +
        "to other instances will silently miss events.",
    );
    return;
  }

  const pubClient = new Redis(redisUrl, {
    maxRetriesPerRequest: 2,
    // Keep reconnecting in the background if Redis blips — the adapter
    // recovers on its own once the connection is back.
    retryStrategy: (times) => Math.min(times * 500, 10_000),
  });
  const subClient = pubClient.duplicate();

  for (const client of [pubClient, subClient]) {
    client.on("error", (err) =>
      console.error("[Realtime] Redis client error:", err.message),
    );
  }

  try {
    // Fail fast at boot if Redis is unreachable: bounded by
    // maxRetriesPerRequest so boot doesn't hang on a dead Redis.
    await pubClient.ping();

    io.adapter(createAdapter(pubClient, subClient));
    console.log(
      `[Realtime] Redis adapter attached (${redisUrl}) — rooms are now cluster-wide`,
    );
  } catch (error) {
    console.error(
      "[Realtime] Could not reach Redis — falling back to single-node mode. " +
        "Do not scale to multiple replicas until this is fixed:",
      error instanceof Error ? error.message : error,
    );
    pubClient.disconnect();
    subClient.disconnect();
  }
};
