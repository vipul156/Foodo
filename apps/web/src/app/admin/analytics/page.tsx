// ============================================================
// Foodo — Admin Analytics Page (/admin/analytics) — Real Data
// ============================================================

"use client";

import { useMemo } from "react";
import Link from "next/link";
import { GlassCard } from "@/components/shared/glass-card";
import { RoleGuard } from "@/components/shared/role-guard";
import { useGetPlatformStats } from "@/features/admin/api";
import type { IDailyRevenuePoint } from "@/types";
import {
  Loader2,
  AlertCircle,
  IndianRupee,
  Users,
  Store,
  Bike,
  ShoppingBag,
  CheckCircle2,
  XCircle,
  Crown,
  ArrowRight,
} from "lucide-react";

export default function AdminAnalyticsPage() {
  const { data: stats, isLoading, error } = useGetPlatformStats();

  const completionRate = useMemo(() => {
    if (!stats) return null;
    const resolved = stats.orders.delivered + stats.orders.cancelled;
    return resolved > 0
      ? Math.round((stats.orders.delivered / resolved) * 100)
      : null;
  }, [stats]);

  const hasData = stats && stats.orders.total > 0;

  return (
    <RoleGuard allowedRoles={["admin"]}>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h2 className="text-xl font-bold tracking-tight">Platform analytics</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Users, restaurants, riders, and revenue across Foodo
          </p>
        </div>

        {isLoading ? (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-24 animate-pulse rounded-2xl bg-muted/60"
                />
              ))}
            </div>
            <div className="h-64 animate-pulse rounded-2xl bg-muted/60" />
          </div>
        ) : error || !stats ? (
          <GlassCard className="flex flex-col items-center justify-center py-16 text-center">
            <AlertCircle className="mb-4 h-10 w-10 text-destructive" />
            <h3 className="mb-2 text-lg font-semibold">
              Couldn&apos;t load platform stats
            </h3>
            <p className="max-w-sm text-sm text-muted-foreground">
              The admin service didn&apos;t respond. Check that it&apos;s running
              and refresh the page.
            </p>
          </GlassCard>
        ) : (
          <>
            {/* ── Key platform numbers ───────────────────────── */}
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard
                icon={IndianRupee}
                label="Gross revenue"
                value={`₹${stats.revenue.total.toLocaleString("en-IN")}`}
                sub={`${stats.orders.total.toLocaleString("en-IN")} orders all-time`}
                emphasis
              />
              <StatCard
                icon={Users}
                label="Users"
                value={stats.users.total.toLocaleString("en-IN")}
                sub={`${stats.users.newThisMonth} joined this month`}
                href="/admin/users"
              />
              <StatCard
                icon={Store}
                label="Restaurants"
                value={stats.restaurants.total.toLocaleString("en-IN")}
                sub={`${stats.restaurants.open} open now · ${stats.restaurants.pending} pending`}
                href="/admin/restaurants"
              />
              <StatCard
                icon={Bike}
                label="Riders"
                value={stats.riders.total.toLocaleString("en-IN")}
                sub={`${stats.riders.online} online · ${stats.riders.pending} pending`}
                href="/admin/riders"
              />
            </div>

            {/* ── Daily revenue, last 30 days ────────────────── */}
            <section>
              <h3 className="mb-3 px-1 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Revenue — last 30 days
              </h3>
              <GlassCard className="p-5">
                <RevenueBars daily={stats.daily} />
                {!hasData && (
                  <p className="mt-3 text-center text-xs text-muted-foreground">
                    No paid orders yet — the chart fills in as orders arrive
                  </p>
                )}
              </GlassCard>
            </section>

            {/* ── Order health ───────────────────────────────── */}
            <section className="grid gap-6 lg:grid-cols-2">
              <div>
                <h3 className="mb-3 px-1 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                  Order outcomes
                </h3>
                <GlassCard className="p-5">
                  <div className="grid grid-cols-3 gap-4">
                    <Outcome
                      icon={ShoppingBag}
                      tone="text-foreground"
                      value={stats.orders.total}
                      label="Total"
                    />
                    <Outcome
                      icon={CheckCircle2}
                      tone="text-emerald-600 dark:text-emerald-400"
                      value={stats.orders.delivered}
                      label="Delivered"
                    />
                    <Outcome
                      icon={XCircle}
                      tone="text-red-600 dark:text-red-400"
                      value={stats.orders.cancelled}
                      label="Cancelled"
                    />
                  </div>
                  {completionRate !== null && (
                    <>
                      <div className="mt-4 h-2 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-emerald-500 transition-all duration-500"
                          style={{ width: `${completionRate}%` }}
                        />
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {completionRate}% of resolved orders were delivered ·{" "}
                        {stats.orders.active} in flight right now
                      </p>
                    </>
                  )}
                </GlassCard>
              </div>

              {/* ── Top restaurants by revenue ─────────────── */}
              <div>
                <h3 className="mb-3 px-1 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                  Top restaurants
                </h3>
                <GlassCard className="divide-y divide-border/50 p-0">
                  {stats.topRestaurants.length === 0 ? (
                    <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                      No paid orders yet
                    </div>
                  ) : (
                    stats.topRestaurants.map((r, i) => (
                      <div
                        key={r.name}
                        className="flex items-center gap-3 px-4 py-3"
                      >
                        <span
                          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-bold ${
                            i === 0
                              ? "bg-primary text-primary-foreground"
                              : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {i === 0 ? <Crown className="h-3.5 w-3.5" /> : i + 1}
                        </span>
                        <p className="min-w-0 flex-1 truncate text-sm font-medium">
                          {r.name}
                        </p>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {r.orders} orders
                        </span>
                        <span className="flex shrink-0 items-center text-sm font-semibold">
                          <IndianRupee className="h-3.5 w-3.5" />
                          {r.revenue.toLocaleString("en-IN")}
                        </span>
                      </div>
                    ))
                  )}
                </GlassCard>
              </div>
            </section>
          </>
        )}
      </div>
    </RoleGuard>
  );
}

// ─── Stat card ───────────────────────────────────────────────

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  emphasis,
  href,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub: string;
  emphasis?: boolean;
  href?: string;
}) {
  const body = (
    <GlassCard
      hover={!!href}
      className={`p-5 ${href ? "cursor-pointer" : ""}`}
    >
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="h-4 w-4" />
        <p className="text-xs font-medium">{label}</p>
        {href && <ArrowRight className="ml-auto h-3.5 w-3.5" />}
      </div>
      <p
        className={`mt-2 text-2xl font-bold tracking-tight ${
          emphasis ? "text-primary" : ""
        }`}
      >
        {value}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
    </GlassCard>
  );

  return href ? <Link href={href}>{body}</Link> : body;
}

// ─── Outcome cell ────────────────────────────────────────────

function Outcome({
  icon: Icon,
  tone,
  value,
  label,
}: {
  icon: React.ComponentType<{ className?: string }>;
  tone: string;
  value: number;
  label: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <Icon className={`h-5 w-5 shrink-0 ${tone}`} />
      <div>
        <p className="text-lg font-bold">{value.toLocaleString("en-IN")}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}

// ─── Revenue bars — pure CSS, same grammar as seller analytics ──

function RevenueBars({ daily }: { daily: IDailyRevenuePoint[] }) {
  // Fill a continuous 30-day axis from sparse aggregation results
  const buckets = useMemo(() => {
    const map = new Map(daily.map((d) => [d.date, d]));
    const out: { date: Date; label: string; revenue: number }[] = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      out.push({
        date: d,
        label: d.toLocaleDateString("en-IN", { day: "numeric", month: "short" }),
        revenue: map.get(key)?.revenue ?? 0,
      });
    }
    return out;
  }, [daily]);

  const max = Math.max(...buckets.map((b) => b.revenue), 1);
  const hasAny = buckets.some((b) => b.revenue > 0);

  return (
    <div>
      <div
        className="flex h-44 items-end gap-1.5"
        role="img"
        aria-label="Platform revenue per day for the last 30 days"
      >
        {buckets.map((bucket, i) => {
          const pct = (bucket.revenue / max) * 100;
          const isToday = i === buckets.length - 1;
          return (
            <div
              key={bucket.date.toISOString()}
              className="group relative flex h-full flex-1 flex-col justify-end"
            >
              <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 hidden -translate-x-1/2 whitespace-nowrap rounded-lg border border-border bg-background px-2.5 py-1 text-xs shadow-lg group-hover:block">
                <span className="font-semibold">
                  ₹{bucket.revenue.toLocaleString("en-IN")}
                </span>
                <span className="text-muted-foreground"> · {bucket.label}</span>
              </div>
              <div
                className={`w-full rounded-t-[4px] transition-all duration-500 ${
                  isToday
                    ? "bg-primary/60"
                    : "bg-primary/30 group-hover:bg-primary/50"
                }`}
                style={{
                  height: `${Math.max(bucket.revenue > 0 ? 3 : 2, pct)}%`,
                }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex gap-1.5">
        {buckets.map((bucket, i) => (
          <span
            key={bucket.date.toISOString()}
            className="flex-1 whitespace-nowrap text-center text-[10px] text-muted-foreground"
          >
            {i % 5 === 0 || i === buckets.length - 1 ? bucket.label : ""}
          </span>
        ))}
      </div>
      {!hasAny && <span className="sr-only">No revenue in this window yet</span>}
    </div>
  );
}
