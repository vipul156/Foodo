// ============================================================
// Foodo — Rider History Page (/rider/history)
// ============================================================

"use client";

import { useMemo, useState } from "react";
import { RoleGuard } from "@/components/shared/role-guard";
import { GlassCard } from "@/components/shared/glass-card";
import { useGetRiderDeliveryHistory } from "@/features/rider/api";
import type { IOrder } from "@/types";
import {
  Clock,
  IndianRupee,
  Loader2,
  AlertCircle,
  MapPin,
  Package,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
} from "lucide-react";

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function dayLabel(date: Date): string {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (isSameDay(date, today)) return "Today";
  if (isSameDay(date, yesterday)) return "Yesterday";
  return date.toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "short",
  });
}

function timeLabel(date: Date): string {
  return date.toLocaleTimeString("en-IN", {
    hour: "numeric",
    minute: "2-digit",
  });
}

interface DayGroup {
  key: string;
  label: string;
  total: number;
  orders: IOrder[];
}

function groupByDay(orders: IOrder[]): DayGroup[] {
  const groups = new Map<string, DayGroup>();

  for (const order of orders) {
    const created = new Date(order.createdAt || "");
    if (Number.isNaN(created.getTime())) continue;

    const key = created.toDateString();
    const group = groups.get(key);
    if (group) {
      group.total += order.riderAmount || 0;
      group.orders.push(order);
    } else {
      groups.set(key, {
        key,
        label: dayLabel(created),
        total: order.riderAmount || 0,
        orders: [order],
      });
    }
  }

  return [...groups.values()];
}

export default function RiderHistoryPage() {
  const { data: history, isLoading, error } = useGetRiderDeliveryHistory();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const dayGroups = useMemo(() => groupByDay(history || []), [history]);

  return (
    <RoleGuard allowedRoles={["rider"]}>
      <div className="space-y-5 pb-6">
        {/* Header */}
        <div>
          <h2 className="text-xl font-bold">Delivery History</h2>
          <p className="text-sm text-muted-foreground">
            {history?.length
              ? `${history.length} completed deliver${history.length === 1 ? "y" : "ies"}`
              : "Your past deliveries"}
          </p>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : error ? (
          <GlassCard className="flex flex-col items-center justify-center py-12 text-center">
            <AlertCircle className="h-10 w-10 text-destructive mb-4" />
            <h3 className="text-lg font-semibold mb-2">Couldn&apos;t load history</h3>
            <p className="max-w-xs text-sm text-muted-foreground">
              Something went wrong fetching your deliveries. Please try again
              later.
            </p>
          </GlassCard>
        ) : !history || history.length === 0 ? (
          <GlassCard className="flex flex-col items-center justify-center py-12 text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
              <Clock className="h-8 w-8 text-primary" />
            </div>
            <h3 className="text-lg font-semibold">No Deliveries Yet</h3>
            <p className="mt-1 max-w-xs text-sm text-muted-foreground">
              Your completed deliveries will appear here once you start
              accepting orders.
            </p>
          </GlassCard>
        ) : (
          <div className="space-y-6">
            {dayGroups.map((group) => (
              <section key={group.key}>
                {/* Day header — count + what the rider made that day */}
                <div className="mb-2 flex items-center justify-between px-1">
                  <h3 className="text-sm font-semibold text-muted-foreground">
                    {group.label}
                    <span className="ml-2 font-normal">
                      {group.orders.length} deliver{group.orders.length === 1 ? "y" : "ies"}
                    </span>
                  </h3>
                  <span className="flex items-center text-sm font-semibold text-primary">
                    <IndianRupee className="h-3.5 w-3.5" />
                    {group.total}
                  </span>
                </div>

                <GlassCard className="divide-y divide-border/50 p-0">
                  {group.orders.map((order) => {
                    const created = new Date(order.createdAt || "");
                    const expanded = expandedId === order._id;

                    return (
                      <div key={order._id}>
                        {/* Row — tap to expand the delivery details */}
                        <button
                          type="button"
                          onClick={() => setExpandedId(expanded ? null : order._id)}
                          className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent/50 transition-colors"
                          aria-expanded={expanded}
                        >
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10">
                            <Package className="h-4.5 w-4.5 text-primary" />
                          </span>

                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">
                              {order.restaurantName}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {timeLabel(created)} · {order.items.length} item
                              {order.items.length === 1 ? "" : "s"} ·{" "}
                              {order.distance?.toFixed(1) || "-"} km
                            </p>
                          </div>

                          <div className="flex shrink-0 items-center gap-2">
                            <span className="flex items-center text-sm font-semibold">
                              <IndianRupee className="h-3.5 w-3.5" />
                              {order.riderAmount}
                            </span>
                            {expanded ? (
                              <ChevronUp className="h-4 w-4 text-muted-foreground" />
                            ) : (
                              <ChevronDown className="h-4 w-4 text-muted-foreground" />
                            )}
                          </div>
                        </button>

                        {/* Expanded details */}
                        {expanded && (
                          <div className="space-y-2 px-4 pb-4 pt-1">
                            <div className="flex items-start gap-2 text-xs text-muted-foreground">
                              <MapPin className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                              <span>
                                {order.deliveryAddress?.formattedAddress ||
                                  "Delivery address available in app"}
                              </span>
                            </div>
                            <div className="space-y-1 border-t border-border/40 pt-2">
                              {order.items.map((item, i) => (
                                <div
                                  key={i}
                                  className="flex items-center justify-between text-xs"
                                >
                                  <span className="text-foreground/80">
                                    <span className="mr-1 text-muted-foreground">
                                      ×{item.quantity}
                                    </span>
                                    {item.name}
                                  </span>
                                  <span className="text-muted-foreground">
                                    ₹{item.price * item.quantity}
                                  </span>
                                </div>
                              ))}
                            </div>
                            <p className="flex items-center gap-1.5 border-t border-border/40 pt-2 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              Delivered {timeLabel(created)}
                            </p>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </GlassCard>
              </section>
            ))}
          </div>
        )}
      </div>
    </RoleGuard>
  );
}
