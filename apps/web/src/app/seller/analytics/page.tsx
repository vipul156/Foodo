// ============================================================
// Foodo — Seller Analytics Page (/seller/analytics)
// ============================================================

"use client";

import { useMemo, useState } from "react";
import { GlassCard } from "@/components/shared/glass-card";
import { RoleGuard } from "@/components/shared/role-guard";
import { useGetMyRestaurant, useGetMenuItems } from "@/features/restaurants/api";
import { useGetSellerAnalytics, type ISellerAnalytics } from "@/features/orders/api";
import {
  Loader2,
  AlertCircle,
  IndianRupee,
  ShoppingBag,
  CheckCircle2,
  XCircle,
  TrendingUp,
  TrendingDown,
  Minus,
  Crown,
} from "lucide-react";
import Link from "next/link";

type Window = 7 | 30;

// ─── Chart helpers ──────────────────────────────────────────
// Aggregation itself now happens server-side (see getRestaurantAnalytics):
// the page only shapes the rollup payload for display.

interface DayBucket {
  date: Date;
  label: string;
  revenue: number;
  orders: number;
}

function toDayBuckets(analytics: ISellerAnalytics): DayBucket[] {
  return analytics.buckets.map((b) => ({
    date: new Date(`${b.date}T00:00:00Z`),
    label: new Date(`${b.date}T00:00:00Z`).toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    }),
    revenue: b.revenue,
    orders: b.orders,
  }));
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getTime() === b.getTime();
}
export default function SellerAnalyticsPage() {
  const [window, setWindow] = useState<Window>(7);  const {
    data: restaurant,
    isLoading: loadingRestaurant,
    error: restaurantError,
  } = useGetMyRestaurant();
  const {
    data: analytics,
    isLoading: loadingAnalytics,
  } = useGetSellerAnalytics(restaurant?._id || "", window);
  const { data: menuItems } = useGetMenuItems(restaurant?._id || "");

  const stats = useMemo(() => {
    if (!analytics) return null;

    const buckets = toDayBuckets(analytics);
    const topItemsTotal = analytics.topItems.reduce((s, i) => s + i.revenue, 0);

    // Peak weekdays (0=Sun … 6=Sat) — server sends totals indexed by
    // JS getDay() ordering
    const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const weekdayTotals = analytics.weekdayTotals;
    const maxWeekday = Math.max(...weekdayTotals, 1);
    const busiestDayIndex = weekdayTotals.indexOf(Math.max(...weekdayTotals));

    return {
      buckets,
      windowRevenue: analytics.windowRevenue,
      windowOrders: analytics.windowOrders,
      avgOrder: analytics.avgOrder,
      change: analytics.change,
      prevRevenue: analytics.prevRevenue,
      delivered: analytics.delivered,
      cancelled: analytics.cancelled,
      completionRate: analytics.completionRate,
      topItems: analytics.topItems,
      topItemsTotal,
      weekdayTotals,
      weekdayNames,
      maxWeekday,
      busiestDayIndex,
      hasData: analytics.windowOrders > 0 || analytics.delivered > 0 || analytics.cancelled > 0,
    };
  }, [analytics]);

  const isLoading = loadingRestaurant || loadingAnalytics;

  return (
    <RoleGuard allowedRoles={["seller"]}>
      <div className="space-y-6">
        {isLoading ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : restaurantError || !restaurant ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <AlertCircle className="mb-4 h-10 w-10 text-destructive" />
            <h3 className="mb-2 text-lg font-semibold">
              {!restaurant ? "No Restaurant Found" : "Something went wrong"}
            </h3>
            <p className="mb-6 max-w-sm text-sm text-muted-foreground">
              {!restaurant
                ? "You haven't registered your restaurant yet."
                : "Couldn't load your restaurant details."}
            </p>
            {!restaurant && (
              <Link
                href="/seller/settings"
                className="inline-flex h-10 items-center justify-center rounded-xl bg-primary px-5 text-sm font-medium text-primary-foreground hover:brightness-110 transition-all"
              >
                Register Your Restaurant
              </Link>
            )}
          </div>
        ) : !stats || !stats.hasData ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <ShoppingBag className="mb-4 h-12 w-12 text-muted-foreground/30" />
            <h3 className="mb-2 text-lg font-semibold">No orders to analyze yet</h3>
            <p className="max-w-sm text-sm text-muted-foreground">
              Once customers start ordering, your revenue trend, best-selling
              dishes, and busiest days will appear here.
            </p>
          </div>
        ) : (
          <>
            {/* ── Revenue trend ─────────────────────────────── */}
            <section>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-baseline gap-3">
                  <h2 className="flex items-center text-2xl font-bold tracking-tight">
                    <IndianRupee className="h-5 w-5" />
                    {stats.windowRevenue.toLocaleString("en-IN")}
                  </h2>
                  <RevenueChange change={stats.change} />
                </div>
                {/* 7/30-day window toggle */}
                <div
                  className="inline-flex rounded-xl border border-border bg-muted/40 p-0.5"
                  role="group"
                  aria-label="Time window"
                >
                  {([7, 30] as Window[]).map((w) => (
                    <button
                      key={w}
                      type="button"
                      onClick={() => setWindow(w)}
                      aria-pressed={window === w}
                      className={`h-8 rounded-[10px] px-4 text-xs font-semibold transition-all ${
                        window === w
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {w} days
                    </button>
                  ))}
                </div>
              </div>

              <GlassCard className="p-5">
                <RevenueBars
                  buckets={stats.buckets}
                  window={window}
                />
                <div className="mt-4 grid grid-cols-3 gap-4 border-t border-border/50 pt-4 text-center">
                  <div>
                    <p className="text-xs text-muted-foreground">Orders</p>
                    <p className="mt-0.5 text-lg font-bold">{stats.windowOrders}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Avg / order</p>
                    <p className="mt-0.5 flex items-center justify-center text-lg font-bold">
                      <IndianRupee className="h-3.5 w-3.5" />
                      {stats.avgOrder}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Best day</p>
                    <p className="mt-0.5 text-lg font-bold">
                      {bestDayLabel(stats.buckets)}
                    </p>
                  </div>
                </div>
              </GlassCard>
            </section>

            {/* ── Reliability + peak days ───────────────────── */}
            <section className="grid gap-6 lg:grid-cols-2">
              <div className="flex flex-col">
                <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                  Order outcomes
                </h3>
                <GlassCard className="flex flex-1 flex-col justify-center p-5">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="flex items-center gap-3">
                      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 dark:bg-emerald-950">
                        <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                      </span>
                      <div>
                        <p className="text-xl font-bold">{stats.delivered}</p>
                        <p className="text-xs text-muted-foreground">Delivered</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-50 dark:bg-red-950">
                        <XCircle className="h-5 w-5 text-red-600 dark:text-red-400" />
                      </span>
                      <div>
                        <p className="text-xl font-bold">{stats.cancelled}</p>
                        <p className="text-xs text-muted-foreground">Cancelled</p>
                      </div>
                    </div>
                  </div>
                  {stats.completionRate !== null && (
                    <>
                      <div className="mt-4 h-2 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-emerald-500 transition-all duration-500"
                          style={{ width: `${stats.completionRate}%` }}
                        />
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {stats.completionRate}% of completed-and-cancelled orders
                        were delivered
                      </p>
                    </>
                  )}
                </GlassCard>
              </div>

              <div className="flex flex-col">
                <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                  Revenue by weekday
                </h3>
                <GlassCard className="flex flex-1 flex-col justify-end p-5">
                  <div className="flex h-28 items-end justify-between gap-2">
                    {stats.weekdayTotals.map((total, i) => (
                      <div
                        key={i}
                        className="flex h-full flex-1 flex-col items-center justify-end gap-1.5"
                      >
                        <span
                          className={`w-full max-w-7 rounded-md transition-all duration-500 ${
                            i === stats.busiestDayIndex
                              ? "bg-primary"
                              : "bg-primary/25"
                          }`}
                          style={{
                            height: `${Math.max(4, (total / stats.maxWeekday) * 100)}%`,
                          }}
                          title={`${stats.weekdayNames[i]}: ₹${total}`}
                        />
                        <span
                          className={`text-[10px] font-medium ${
                            i === stats.busiestDayIndex
                              ? "text-foreground"
                              : "text-muted-foreground"
                          }`}
                        >
                          {stats.weekdayNames[i]}
                        </span>
                      </div>
                    ))}
                  </div>
                </GlassCard>
              </div>
            </section>

            {/* ── Top items ─────────────────────────────────── */}
            {stats.topItems.length > 0 && (
              <section>
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                    Best sellers
                  </h3>
                  <Link
                    href="/seller/menu"
                    className="text-xs font-medium text-primary hover:underline"
                  >
                    {menuItems?.length || 0} items on menu
                  </Link>
                </div>
                <GlassCard className="divide-y divide-border/50 p-0">
                  {stats.topItems.map((item, i) => {
                    const share = stats.topItemsTotal
                      ? Math.round((item.revenue / stats.topItemsTotal) * 100)
                      : 0;
                    return (
                      <div
                        key={item.name}
                        className="flex items-center gap-4 px-5 py-3.5"
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
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">
                            {item.name}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {item.qty} sold · {share}% of top revenue
                          </p>
                        </div>
                        <p className="flex shrink-0 items-center text-sm font-semibold">
                          <IndianRupee className="h-3.5 w-3.5" />
                          {item.revenue.toLocaleString("en-IN")}
                        </p>
                      </div>
                    );
                  })}
                </GlassCard>
              </section>
            )}
          </>
        )}
      </div>
    </RoleGuard>
  );
}

// ─── Revenue change pill ─────────────────────────────────────

function RevenueChange({ change }: { change: number }) {
  const Icon = change > 0 ? TrendingUp : change < 0 ? TrendingDown : Minus;
  const tone =
    change > 0
      ? "text-emerald-600 dark:text-emerald-400"
      : change < 0
        ? "text-red-600 dark:text-red-400"
        : "text-muted-foreground";
  const label =
    change === 0
      ? "flat"
      : `${change > 0 ? "+" : ""}${change}% vs prev ${change >= 0 ? "window" : "window"}`;

  return (
    <span
      className={`inline-flex items-center gap-1 text-sm font-medium ${tone}`}
      title={`Previous window: ₹${label}`}
    >
      <Icon className="h-4 w-4" />
      {change === 0 ? "No change" : label}
    </span>
  );
}

function bestDayLabel(buckets: DayBucket[]): string {
  if (!buckets.length) return "—";
  const best = buckets.reduce((a, b) => (b.revenue > a.revenue ? b : a));
  if (best.revenue === 0) return "—";
  return isSameDay(best.date, new Date())
    ? "Today"
    : best.label;
}

// ─── Revenue bar chart — pure divs, no chart library ─────────

function RevenueBars({
  buckets,
  window,
}: {
  buckets: DayBucket[];
  window: Window;
}) {
  const max = Math.max(...buckets.map((b) => b.revenue), 1);
  const bestIndex = buckets.reduce(
    (best, b, i) => (b.revenue > buckets[best].revenue ? i : best),
    0,
  );
  const hasAny = buckets.some((b) => b.revenue > 0);

  // Label a subset of x-axis ticks depending on density
  const tickEvery = window === 7 ? 1 : 5;

  return (
    <div>
      <div
        className="flex h-44 items-end gap-1.5"
        role="img"
        aria-label={`Daily revenue for the last ${window} days`}
      >
        {buckets.map((bucket, i) => {
          const pct = (bucket.revenue / max) * 100;
          const isBest = i === bestIndex && bucket.revenue > 0;
          const isToday = isSameDay(bucket.date, new Date());
          return (
            <div
              key={bucket.date.toISOString()}
              className="group relative flex h-full flex-1 flex-col justify-end"
            >
              {/* Tooltip on hover */}
              <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 hidden -translate-x-1/2 whitespace-nowrap rounded-lg border border-border bg-background px-2.5 py-1 text-xs shadow-lg group-hover:block">
                <span className="font-semibold">
                  ₹{bucket.revenue.toLocaleString("en-IN")}
                </span>
                <span className="text-muted-foreground"> · {bucket.label}</span>
              </div>
              <div
                className={`w-full rounded-t-[4px] transition-all duration-500 ${
                  isBest
                    ? "bg-primary"
                    : isToday
                      ? "bg-primary/60"
                      : "bg-primary/30 group-hover:bg-primary/50"
                }`}
                style={{ height: `${Math.max(bucket.revenue > 0 ? 3 : 2, pct)}%` }}
              />
            </div>
          );
        })}
      </div>
      {/* X axis labels */}
      <div className="mt-2 flex gap-1.5">
        {buckets.map((bucket, i) => (
          <span
            key={bucket.date.toISOString()}
            className="flex-1 overflow-visible whitespace-nowrap text-center text-[10px] text-muted-foreground"
          >
            {i % tickEvery === 0 || i === buckets.length - 1 ? bucket.label : ""}
          </span>
        ))}
      </div>
      {!hasAny && (
        <p className="mt-3 text-center text-xs text-muted-foreground">
          No paid orders in this window yet
        </p>
      )}
    </div>
  );
}
