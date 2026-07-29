// ============================================================
// Foodo — Seller Dashboard Page (/seller) — Real Data
// ============================================================

"use client";

import { GlassCard } from "@/components/shared/glass-card";
import { RoleGuard } from "@/components/shared/role-guard";
import { useGetMyRestaurant, useGetMenuItems } from "@/features/restaurants/api";
import { useGetRestaurantOrders } from "@/features/orders/api";
import {
  Plus,
  Loader2,
  AlertCircle,
  ShoppingBag,
} from "lucide-react";
import Link from "next/link";

const statusColors: Record<string, string> = {
  placed: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-400",
  accepted: "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-400",
  preparing:
    "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-400",
  ready_for_rider:
    "bg-purple-50 text-purple-700 dark:bg-purple-950 dark:text-purple-400",
  rider_assigned:
    "bg-cyan-50 text-cyan-700 dark:bg-cyan-950 dark:text-cyan-400",
  picked_up:
    "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
  delivered:
    "bg-zinc-50 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400",
  cancelled: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-400",
};

const statusLabels: Record<string, string> = {
  placed: "Placed",
  accepted: "Accepted",
  preparing: "Preparing",
  ready_for_rider: "Ready",
  rider_assigned: "Rider Assigned",
  picked_up: "Picked Up",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

export default function SellerDashboardPage() {
  const {
    data: restaurant,
    isLoading: loadingRestaurant,
    error: restaurantError,
  } = useGetMyRestaurant();
  const { data: menuItems } = useGetMenuItems(restaurant?._id || "");
  const { data: orders } = useGetRestaurantOrders(restaurant?._id || "", 5);

  const isLoading = loadingRestaurant;

  return (
    <RoleGuard allowedRoles={["seller"]}>
      <div className="space-y-8">
        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : restaurantError || !restaurant ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <AlertCircle className="h-10 w-10 text-destructive mb-4" />
            <h3 className="text-lg font-semibold mb-2">
              {!restaurant
                ? "No Restaurant Found"
                : "Something went wrong"}
            </h3>
            <p className="text-sm text-muted-foreground max-w-sm mb-6">
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
            {/* Quick Stats */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <QuickStat
                label="Today's Orders"
                value={String(orders?.length || 0)}
                change={`${orders?.length || 0} active`}
              />
              <QuickStat
                label="Total Menu Items"
                value={String(menuItems?.length || 0)}
                change="items"
              />
              <QuickStat
                label="Status"
                value={restaurant.isOpen ? "Open" : "Closed"}
                change={restaurant.isOpen ? "Accepting orders" : "Not accepting"}
              />
              <QuickStat
                label="Phone"
                value={String(restaurant.phone || "-")}
                change="Contact"
              />
            </div>

            {/* Recent Orders */}
            <GlassCard>
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h2 className="text-lg font-semibold">Recent Orders</h2>
                  <p className="text-sm text-muted-foreground">
                    Latest {orders?.length || 0} order(s)
                  </p>
                </div>
                <Link
                  href="/seller/orders"
                  className="inline-flex h-9 items-center justify-center rounded-xl border border-border px-4 text-xs font-medium hover:bg-accent transition-all"
                >
                  View All
                </Link>
              </div>
              {orders && orders.length > 0 ? (
                <div className="space-y-3">
                  {orders.map((order: any) => (
                    <OrderRow key={order._id} order={order} />
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <ShoppingBag className="h-10 w-10 text-muted-foreground/30 mb-3" />
                  <p className="text-sm text-muted-foreground">
                    No orders yet
                  </p>
                </div>
              )}
            </GlassCard>

            {/* Quick Actions */}
            <div className="grid gap-4 sm:grid-cols-2">
              <Link href="/seller/menu">
                <GlassCard hover className="cursor-pointer">
                  <div className="flex items-center gap-4">
                    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
                      <Plus className="h-6 w-6 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold">Manage Menu</h3>
                      <p className="text-sm text-muted-foreground">
                        {menuItems?.length || 0} items · Add or edit dishes
                      </p>
                    </div>
                  </div>
                </GlassCard>
              </Link>
              <Link href="/seller/orders">
                <GlassCard hover className="cursor-pointer">
                  <div className="flex items-center gap-4">
                    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-50 dark:bg-emerald-950">
                      <ShoppingBag className="h-6 w-6 text-emerald-600" />
                    </div>
                    <div>
                      <h3 className="font-semibold">View Orders</h3>
                      <p className="text-sm text-muted-foreground">
                        {orders?.length || 0} pending orders
                      </p>
                    </div>
                  </div>
                </GlassCard>
              </Link>
            </div>
          </>
        )}
      </div>
    </RoleGuard>
  );
}

function QuickStat({
  label,
  value,
  change,
}: {
  label: string;
  value: string;
  change: string;
}) {
  return (
    <GlassCard>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
      <span className="mt-1 inline-block text-xs font-medium text-emerald-600 dark:text-emerald-400">
        {change}
      </span>
    </GlassCard>
  );
}

function OrderRow({ order }: { order: any }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border/50 p-4">
      <div className="flex items-center gap-4 min-w-0">
        <span className="text-sm font-medium">
          #{order._id?.slice(-6)?.toUpperCase()}
        </span>
        <span className="text-xs text-muted-foreground">
          {order.items?.length || 0} item(s)
        </span>
      </div>
      <span
        className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
          statusColors[order.status] || ""
        }`}
      >
        {statusLabels[order.status] || order.status}
      </span>
      <span className="text-sm font-medium">
        ₹{order.totalAmount || 0}
      </span>
    </div>
  );
}
