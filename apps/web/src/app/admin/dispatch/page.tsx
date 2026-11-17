// ============================================================
// Foodo — Admin Dispatch Page (/admin/dispatch)
// ============================================================
// Observability for the AI dispatch swarm. When an order goes
// ready_for_rider the swarm picks a rider, or batches it with a
// neighbour, or parks it in a TTL'd pool and moves on.
//
// This page is the pool: the orders that did NOT go straight to a
// rider. That is the part a human can still act on — the rest is the
// swarm's own work.
//
// The counters are the swarm container's, not the platform's: they
// reset on every cold start. The page says so instead of implying a
// trend line it cannot draw.

"use client";

import { GlassCard } from "@/components/shared/glass-card";
import { RoleGuard } from "@/components/shared/role-guard";
import { useDispatchSnapshot, type DispatchPoolRow } from "@/features/dispatch/api";
import {
  AlertTriangle,
  CloudRain,
  Loader2,
  RefreshCw,
  Route,
  Waypoints,
} from "lucide-react";

/** Past this, a parked order is a service failure, not a queue. */
const STUCK_MINUTES = 15;

export default function AdminDispatchPage() {
  const { data, isLoading, isError, isFetching, refetch, dataUpdatedAt } =
    useDispatchSnapshot();

  const health = data?.health;
  const pool = data?.pending_pool ?? [];
  const stuck = pool.filter((row) => waitingMinutes(row) >= STUCK_MINUTES).length;

  return (
    <RoleGuard allowedRoles={["admin"]}>
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold tracking-tight">Dispatch</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Ready orders the AI swarm couldn&apos;t hand to a rider.
            </p>
          </div>

          <div className="flex items-center gap-2">
            {stuck > 0 && (
              <span className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-destructive/10 px-3 text-xs font-semibold text-destructive">
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                {stuck} waiting over {STUCK_MINUTES} min
              </span>
            )}
            <button
              onClick={() => void refetch()}
              disabled={isFetching}
              className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-border px-3 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-60"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`}
                aria-hidden="true"
              />
              {dataUpdatedAt
                ? `Updated ${timeAgo(new Date(dataUpdatedAt).toISOString())}`
                : "Refresh"}
            </button>
          </div>
        </div>

        {isError ? (
          <GlassCard className="flex flex-col items-center py-14 text-center">
            <AlertTriangle className="h-10 w-10 text-destructive" aria-hidden="true" />
            <h3 className="mt-3 text-base font-semibold">Couldn&apos;t read the swarm</h3>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              The dispatch service didn&apos;t answer. Dispatch keeps running without this
              page — the pool is a read.
            </p>
            <button
              onClick={() => void refetch()}
              className="mt-4 inline-flex h-9 items-center rounded-xl border border-border px-4 text-xs font-medium transition-colors hover:bg-accent"
            >
              Try again
            </button>
          </GlassCard>
        ) : isLoading || !health ? (
          <GlassCard className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
          </GlassCard>
        ) : (
          <>
            {health.weather_degraded && (
              <div className="flex items-start gap-2.5 rounded-xl border border-amber-600/40 bg-amber-500/5 p-3 text-sm">
                <CloudRain
                  className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400"
                  aria-hidden="true"
                />
                <p>
                  <span className="font-medium">Weather is degrading dispatch.</span> The swarm
                  is widening its radius and batching harder, so a rider may take longer to
                  appear.
                </p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Status" value={health.status} />
              <Stat label="Dispatched" value={health.orders_dispatched} />
              <Stat label="Batches" value={health.batches_formed} />
              <Stat label="Broadcasts" value={health.broadcasts} />
            </div>
            <p className="-mt-3 text-xs text-muted-foreground">
              Counters belong to the current dispatch container — they reset when it restarts,
              so read them as &ldquo;recently&rdquo;, not as platform totals.
            </p>

            <section>
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  <Waypoints className="h-4 w-4" aria-hidden="true" />
                  Waiting for a rider
                </h3>
                <span className="text-xs text-muted-foreground">
                  {pool.length} order{pool.length === 1 ? "" : "s"}
                </span>
              </div>

              {pool.length === 0 ? (
                <GlassCard className="flex flex-col items-center py-12 text-center">
                  <Route className="h-9 w-9 text-muted-foreground/50" aria-hidden="true" />
                  <p className="mt-3 text-sm font-medium">Nothing parked</p>
                  <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                    Every ready order went straight to a rider.
                  </p>
                </GlassCard>
              ) : (
                <GlassCard className="overflow-hidden p-0">
                  <ul className="divide-y divide-border/60">
                    {pool.map((row, index) => (
                      <PoolRow key={row.order_id ?? index} row={row} />
                    ))}
                  </ul>
                </GlassCard>
              )}

              <p className="mt-3 text-xs text-muted-foreground">
                The swarm retries a parked order when the next ready order arrives, and the pool
                entry expires on its own after its TTL (2h by default). An order sitting here
                longer than {STUCK_MINUTES} minutes needs a human.
              </p>
            </section>
          </>
        )}
      </div>
    </RoleGuard>
  );
}

// ─── Pieces ──────────────────────────────────────────────────

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <GlassCard className="px-4 py-3">
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </GlassCard>
  );
}

function PoolRow({ row }: { row: DispatchPoolRow }) {
  const minutes = waitingMinutes(row);
  const isStuck = minutes >= STUCK_MINUTES;

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="font-mono text-xs font-medium">
          {row.order_id ? `#${row.order_id.slice(-8).toUpperCase()}` : "unknown order"}
        </p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {row.restaurant_id ? `restaurant ${row.restaurant_id.slice(-8)}` : "restaurant unknown"}
          {row.prep_minutes !== null && ` · ${Math.round(row.prep_minutes)} min prep`}
        </p>
      </div>

      <span
        className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
          isStuck ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"
        }`}
      >
        waiting {formatMinutes(minutes)}
      </span>
    </li>
  );
}

// ─── Helpers ─────────────────────────────────────────────────

function waitingMinutes(row: DispatchPoolRow): number {
  if (typeof row.parked_at !== "number") return 0;
  return Math.max(0, Math.floor((Date.now() / 1000 - row.parked_at) / 60));
}

function formatMinutes(minutes: number): string {
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const minutes = Math.floor((Date.now() - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}
