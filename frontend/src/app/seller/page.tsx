// ============================================================
// Foodo — Seller Dashboard Page (/seller) — Real Data
// ============================================================

"use client";

import { useMemo } from "react";
import { GlassCard } from "@/components/shared/glass-card";
import { RoleGuard } from "@/components/shared/role-guard";
import { useGetMyRestaurant, useGetMenuItems } from "@/features/restaurants/api";
import { useGetRestaurantOrders } from "@/features/orders/api";
import type { IOrder, OrderStatus } from "@/types";
import {
  Loader2,
  AlertCircle,
  ShoppingBag,
  ChevronRight,
  IndianRupee,
  Flame,
  CheckCheck,
  BookOpen,
} from "lucide-react";
import Link from "next/link";

const statusStyles: Record<string, string> = {
  placed: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-400",
  accepted: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-400",
  preparing: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-400",
  ready_for_rider: "bg-purple-50 text-purple-700 dark:bg-purple-950 dark:text-purple-400",
  rider_assigned: "bg-cyan-50 text-cyan-700 dark:bg-cyan-950 dark:text-cyan-400",
  picked_up: "bg-teal-50 text-teal-700 dark:bg-teal-950 dark:text-teal-400",
  delivered: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  cancelled: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-400",
};

const statusLabels: Record<string, string> = {
  placed: "New",
  accepted: "Accepted",
  preparing: "Preparing",
  ready_for_rider: "Ready",
  rider_assigned: "On the way",
  picked_up: "On the way",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

// Statuses where the seller still has a move to make
const ACTION_NEEDED: OrderStatus[] = [
  "placed",
  "accepted",
  "preparing",
  "ready_for_rider",
];

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function timeAgo(date: Date): string {
  const mins = Math.floor((Date.now() - date.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function SellerDashboardPage() {
  const {
    data: restaurant,
    isLoading: loadingRestaurant,
    error: restaurantError,
  } = useGetMyRestaurant();
  const { data: menuItems } = useGetMenuItems(restaurant?._id || "");
  // Fetch a wider window so today's stats are real; recent list uses the first 5
  const { data: orders } = useGetRestaurantOrders(restaurant?._id || "", 50);

  const isLoading = loadingRestaurant;

  const stats = useMemo(() => {
    const all = orders || [];
    const today = new Date();

    const todays = all.filter(
      (o) => o.createdAt && isSameDay(new Date(o.createdAt), today),
    );

    const revenueToday = todays
      .filter((o) => o.status !== "cancelled")
      .reduce((sum, o) => sum + (o.totalAmount || 0), 0);

    const activeOrders = all.filter((o) =>
      ACTION_NEEDED.includes(o.status as OrderStatus),
    );

    const completedToday = todays.filter((o) => o.status === "delivered").length;

    return {
      revenueToday,
      ordersToday: todays.length,
      activeOrders,
      completedToday,
      recent: all.slice(0, 5),
      hasAnyOrders: all.length > 0,
    };
  }, [orders]);

  return (
    <RoleGuard allowedRoles={["seller"]}>
      <div className="space-y-8">
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
        ) : (
          <>
            {/* ── Today's numbers ─────────────────────────────── */}
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard
                icon={IndianRupee}
                label="Revenue today"
                value={`₹${stats.revenueToday.toLocaleString("en-IN")}`}
                sub={`${stats.ordersToday} order${stats.ordersToday !== 1 ? "s" : ""} today`}
              />
              <StatCard
                icon={Flame}
                label="Need your action"
                value={String(stats.activeOrders.length)}
                sub={
                  stats.activeOrders.length > 0
                    ? "Accept, prepare, or mark ready"
                    : "Nothing waiting on you"
                }
                emphasis={stats.activeOrders.length > 0}
                href="/seller/orders"
              />
              <StatCard
                icon={CheckCheck}
                label="Completed today"
                value={String(stats.completedToday)}
                sub={
                  stats.completedToday > 0
                    ? "Delivered to customers"
                    : "No deliveries yet today"
                }
              />
              <StatCard
                icon={BookOpen}
                label="On the menu"
                value={String(menuItems?.length || 0)}
                sub={menuItems?.length ? "Dishes customers can order" : "Add your first dish"}
                href="/seller/menu"
              />
            </div>

            {/* ── Recent orders ───────────────────────────────── */}
            <section>
              <div className="mb-3 flex items-center justify-between px-1">
                <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                  Recent orders
                </h3>
                <Link
                  href="/seller/orders"
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  View all
                  <ChevronRight className="h-3.5 w-3.5" />
                </Link>
              </div>

              <GlassCard className="divide-y divide-border/50 p-0">
                {!stats.hasAnyOrders ? (
                  <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
                    <ShoppingBag className="mb-3 h-10 w-10 text-muted-foreground/30" />
                    <p className="text-sm font-medium">No orders yet</p>
                    <p className="mt-1 max-w-xs text-sm text-muted-foreground">
                      New orders appear here the moment customers check out.
                      Make sure your restaurant is marked Open.
                    </p>
                  </div>
                ) : (
                  stats.recent.map((order) => (
                    <OrderRow key={order._id} order={order} />
                  ))
                )}
              </GlassCard>
            </section>

            {/* ── Quick actions ───────────────────────────────── */}
            <div className="grid gap-4 sm:grid-cols-2">
              <ActionCard
                href="/seller/menu"
                icon={BookOpen}
                title="Manage menu"
                sub={`${menuItems?.length || 0} item${menuItems?.length !== 1 ? "s" : ""} · add or edit dishes`}
              />
              <ActionCard
                href="/seller/orders"
                icon={ShoppingBag}
                title="Order board"
                sub={
                  stats.activeOrders.length > 0
                    ? `${stats.activeOrders.length} in progress right now`
                    : "All orders handled"
                }
              />
            </div>
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
    <GlassCard hover={!!href} className={`p-5 ${href ? "cursor-pointer" : ""}`}>
      <div className="flex items-center gap-2">
        <Icon
          className={`h-4 w-4 ${emphasis ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}
        />
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {href && <ChevronRight className="ml-auto h-3.5 w-3.5 text-muted-foreground" />}
      </div>
      <p
        className={`mt-2 text-2xl font-bold tracking-tight ${
          emphasis ? "text-amber-600 dark:text-amber-400" : ""
        }`}
      >
        {value}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
    </GlassCard>
  );

  return href ? <Link href={href}>{body}</Link> : body;
}

// ─── Order row — four aligned zones ──────────────────────────

function OrderRow({ order }: { order: IOrder }) {
  const status = order.status as string;
  const createdAt = order.createdAt ? new Date(order.createdAt) : null;
  const itemCount = order.items?.length || 0;

  return (
    <Link
      href="/seller/orders"
      className="group flex items-center gap-4 px-4 py-3.5 transition-colors hover:bg-accent/50"
    >
      {/* Order id + meta */}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">
          #{order._id?.slice(-6)?.toUpperCase()}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {createdAt ? timeAgo(createdAt) : ""}
          {itemCount > 0 && ` · ${itemCount} item${itemCount !== 1 ? "s" : ""}`}
        </p>
      </div>

      {/* Status */}
      <span
        className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
          statusStyles[status] || ""
        }`}
      >
        {statusLabels[status] || status}
      </span>

      {/* Amount */}
      <span className="w-16 shrink-0 text-right text-sm font-semibold">
        ₹{order.totalAmount || 0}
      </span>

      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

// ─── Quick action card ───────────────────────────────────────

function ActionCard({
  href,
  icon: Icon,
  title,
  sub,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  sub: string;
}) {
  return (
    <Link href={href}>
      <GlassCard hover className="cursor-pointer">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <Icon className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold">{title}</h3>
            <p className="mt-0.5 text-sm text-muted-foreground">{sub}</p>
          </div>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        </div>
      </GlassCard>
    </Link>
  );
}
