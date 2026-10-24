import { tryCatchStatus } from "@foodo/backend-common";
import type { Request, Response } from "express";

// ─── Dispatch swarm snapshot (proxy to ai-dispatch) ─────────
// ai-dispatch assigns riders automatically when an order goes
// ready_for_rider. Its ops endpoint is internal-key gated, so this route
// is the admin panel's door: isAuth+isAdmin in front, and the service
// adds the shared key server-side.
//
// Two things a snapshot can tell an operator:
//   - health: the swarm's own counters for THIS container. They reset on
//     every cold start, so they read as "since this container started",
//     never as platform totals.
//   - pending_pool: ready orders the swarm could not assign — parked,
//     with a TTL, waiting for a free rider. This is the actionable part.

/** Bounded well under the Lambda's 15s budget. */
const SNAPSHOT_TIMEOUT_MS = 6_000;

interface SnapshotPayload {
  success?: boolean;
  health?: Record<string, unknown>;
  pending_pool?: unknown;
  message?: string;
}

export const getDispatchSnapshot = tryCatchStatus(async (_req: Request, res: Response) => {
  const base = (process.env.DISPATCH_SERVICE_URL ?? "").replace(/\/+$/, "");
  const key = process.env.INTERNAL_SERVICE_KEY ?? "";

  if (!base || !key) {
    return res.status(503).json({
      message:
        "Dispatch snapshot is not configured (DISPATCH_SERVICE_URL / INTERNAL_SERVICE_KEY)",
    });
  }

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(`${base}/api/dispatch/snapshot`, {
      headers: { "x-internal-key": key },
      signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
    });
  } catch (err) {
    console.error(
      "Dispatch snapshot unreachable:",
      err instanceof Error ? err.message : err,
    );
    return res.status(502).json({ message: "Could not reach the dispatch service" });
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    console.error(`Dispatch snapshot responded ${upstream.status}: ${detail.slice(0, 300)}`);
    return res.status(502).json({
      message:
        upstream.status === 403
          ? "Dispatch rejected the service key"
          : "Could not read the dispatch snapshot",
    });
  }

  const payload = (await upstream.json().catch(() => ({}))) as SnapshotPayload;

  // The swarm reports an empty pool on its own failure path; keep the
  // shape stable so the admin view never has to guess.
  return res.json({
    health: payload.health ?? {},
    pending_pool: Array.isArray(payload.pending_pool) ? payload.pending_pool : [],
  });
});
