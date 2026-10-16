// ============================================================
// Foodo — Rider Earnings Page (/rider/earnings)
// ============================================================

"use client";

import { useMemo } from "react";
import Link from "next/link";
import { RoleGuard } from "@/components/shared/role-guard";
import { GlassCard } from "@/components/shared/glass-card";
import { useGetRiderDeliveryHistory } from "@/features/rider/api";
import type { IOrder } from "@/types";
import {
  Wallet,
  IndianRupee,
  Bike,
  Loader2,
  AlertCircle,
  ArrowRight,
  TrendingUp,
  CalendarDays,
  Package,
} from "lucide-react";

// ─── Aggregation helpers ─────────────────────────────────────

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

interface DailyEarnings {
  date: Date;
  total: number;
  deliveries: number;
}

function aggregateByDay(orders: IOrder[]): DailyEarnings[] {
  const byDay = new Map<string, DailyEarnings>();

  for (const order of orders) {
    const created = new Date(order.createdAt || "");
    if (Number.isNaN(created.getTime())) continue;

    const key = created.toDateString();
    const entry = byDay.get(key);
    if (entry) {
      entry.total += order.riderAmount || 0;
      entry.deliveries += 1;
    } else {
      byDay.set(key, {
        date: created,
        total: order.riderAmount || 0,
        deliveries: 1,
      });
    }
  }

  return [...byDay.values()].sort((a, b) => b.date.getTime() - a.date.getTime());
}

export default function RiderEarningsPage() {
  const {
    data: history,
    isLoading,
    error,
  } = useGetRiderDeliveryHistory();

  const stats = useMemo(() => {
    const orders = history || [];
    const today = new Date();

    const todayOrders = orders.filter(
      (o) => o.createdAt && isSameDay(new Date(o.createdAt), today),
    );
    const todayTotal = todayOrders.reduce((sum, o) => sum + (o.riderAmount || 0), 0);

    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 6);
    const weekOrders = orders.filter(
      (o) => o.createdAt && new Date(o.createdAt) >= weekAgo,
    );
    const weekTotal = weekOrders.reduce((sum, o) => sum + (o.riderAmount || 0), 0);

    const lifetimeTotal = orders.reduce((sum, o) => sum + (o.riderAmount || 0), 0);

    return {
      todayTotal,
      todayCount: todayOrders.length,
      weekTotal,
      weekCount: weekOrders.length,
      lifetimeTotal,
      lifetimeCount: orders.length,
      avgPerDelivery: orders.length ? Math.round(lifetimeTotal / orders.length) : 0,
      days: aggregateByDay(orders),
    };
  }, [history]);

  const maxDayTotal = Math.max(...stats.days.map((d) => d.total), 1);

  return (
    <RoleGuard allowedRoles={["rider"]}>
      <div className="space-y-5 pb-6">
        {/* Header */}
        <div>
          <h2 className="text-xl font-bold">Earnings</h2>
          <p className="text-sm text-muted-foreground">
            What you&apos;ve made from deliveries
          </p>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : error ? (
          <GlassCard className="flex flex-col items-center justify-center py-12 text-center">
            <AlertCircle className="h-10 w-10 text-destructive mb-4" />
            <h3 className="text-lg font-semibold mb-2">Couldn&apos;t load earnings</h3>
            <p className="max-w-xs text-sm text-muted-foreground">
              Something went wrong fetching your delivery history. Please try
              again later.
            </p>
          </GlassCard>
        ) : !history || history.length === 0 ? (
          <GlassCard className="flex flex-col items-center justify-center py-12 text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
              <Wallet className="h-8 w-8 text-primary" />
            </div>
            <h3 className="text-lg font-semibold">No earnings yet</h3>
            <p className="mt-1 max-w-xs text-sm text-muted-foreground">
              Complete your first delivery and your earnings will show up here.
            </p>
            <Link
              href="/rider"
              className="mt-5 inline-flex h-10 items-center justify-center rounded-xl bg-primary px-5 text-sm font-medium text-primary-foreground hover:brightness-110 transition-all gap-1.5"
            >
              Go Online
              <ArrowRight className="h-4 w-4" />
            </Link>
          </GlassCard>
        ) : (
          <>
            {/* Today hero — the number a rider checks first */}
            <section className="rounded-2xl bg-primary p-6 text-primary-foreground">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm text-primary-foreground/80">Today</p>
                  <p className="mt-1 flex items-center text-4xl font-bold tracking-tight">
                    <IndianRupee className="h-8 w-8" />
                    {stats.todayTotal}
                  </p>
                  <p className="mt-1.5 text-sm text-primary-foreground/80">
                    {stats.todayCount} deliver{stats.todayCount === 1 ? "y" : "ies"}{" "}
                    today
                  </p>
                </div>
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-foreground/15">
                  <Bike className="h-6 w-6" />
                </span>
              </div>
            </section>

            {/* This week + lifetime */}
            <div className="grid grid-cols-2 gap-4">
              <GlassCard className="p-4">
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <CalendarDays className="h-3.5 w-3.5" />
                  <p className="text-xs font-medium">Last 7 days</p>
                </div>
                <p className="mt-2 flex items-center text-2xl font-bold">
                  <IndianRupee className="h-5 w-5" />
                  {stats.weekTotal}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {stats.weekCount} deliver{stats.weekCount === 1 ? "y" : "ies"}
                </p>
              </GlassCard>
              <GlassCard className="p-4">
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <TrendingUp className="h-3.5 w-3.5" />
                  <p className="text-xs font-medium">All time</p>
                </div>
                <p className="mt-2 flex items-center text-2xl font-bold">
                  <IndianRupee className="h-5 w-5" />
                  {stats.lifetimeTotal}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  avg ₹{stats.avgPerDelivery} / delivery
                </p>
              </GlassCard>
            </div>

            {/* Day-by-day breakdown */}
            <section>
              <h3 className="mb-3 text-sm font-semibold text-muted-foreground">
                Daily breakdown
              </h3>
              <GlassCard className="divide-y divide-border/50 p-0">
                {stats.days.slice(0, 14).map((day) => {
                  const isToday = isSameDay(day.date, new Date());
                  return (
                    <div key={day.date.toDateString()} className="flex items-center gap-4 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">
                          {isToday
                            ? "Today"
                            : day.date.toLocaleDateString("en-IN", {
                                weekday: "short",
                                day: "numeric",
                                month: "short",
                              })}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {day.deliveries} deliver{day.deliveries === 1 ? "y" : "ies"}
                        </p>
                      </div>
                      {/* Bar scaled against the best day */}
                      <div
                        className="h-1.5 rounded-full bg-primary/70"
                        style={{
                          width: `${Math.max(8, (day.total / maxDayTotal) * 96)}px`,
                        }}
                        aria-hidden="true"
                      />
                      <p className="flex w-16 items-center justify-end text-sm font-semibold">
                        <IndianRupee className="h-3.5 w-3.5" />
                        {day.total}
                      </p>
                    </div>
                  );
                })}
              </GlassCard>
            </section>

            {/* Per-delivery detail lives in History */}
            <Link
              href="/rider/history"
              className="flex items-center justify-between rounded-2xl border border-border/60 px-4 py-3.5 text-sm font-medium hover:bg-accent transition-colors"
            >
              <span className="flex items-center gap-2">
                <Package className="h-4 w-4 text-primary" />
                See each delivery in History
              </span>
              <ArrowRight className="h-4 w-4 text-muted-foreground" />
            </Link>
          </>
        )}
      </div>
    </RoleGuard>
  );
}
