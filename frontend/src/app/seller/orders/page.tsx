// ============================================================
// Foodo — Seller Orders Page (/seller/orders)
// ============================================================

"use client";

import { useState, useCallback } from "react";
import { GlassCard } from "@/components/shared/glass-card";
import { RoleGuard } from "@/components/shared/role-guard";
import { useGetMyRestaurant } from "@/features/restaurants/api";
import {
  useGetRestaurantOrders,
  useUpdateOrderStatus,
} from "@/features/orders/api";
import { useSocketEvent } from "@/hooks/use-socket-event";
import {
  SOCKET_EVENTS,
  type RiderAssignedPayload,
} from "@/lib/socket-events";
import type { IOrder, OrderStatus } from "@/types";
import {
  Loader2,
  Clock,
  CheckCircle2,
  CookingPot,
  Bike,
  IndianRupee,
  MapPin,
  Phone,
  ChevronDown,
  ChevronUp,
  AlertCircle,
  PackageOpen,
  Bell,
} from "lucide-react";

const statusConfig: Record<OrderStatus, { label: string; color: string; icon: React.ReactNode }> = {
  placed: {
    label: "New",
    color: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-400",
    icon: <Clock className="h-3 w-3" />,
  },
  accepted: {
    label: "Accepted",
    color: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-400",
    icon: <CheckCircle2 className="h-3 w-3" />,
  },
  preparing: {
    label: "Preparing",
    color: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-400",
    icon: <CookingPot className="h-3 w-3" />,
  },
  ready_for_rider: {
    label: "Ready",
    color: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
    icon: <Bike className="h-3 w-3" />,
  },
  rider_assigned: {
    label: "Picked Up",
    color: "bg-teal-50 text-teal-700 dark:bg-teal-950 dark:text-teal-400",
    icon: <Bike className="h-3 w-3" />,
  },
  picked_up: {
    label: "Picked Up",
    color: "bg-teal-50 text-teal-700 dark:bg-teal-950 dark:text-teal-400",
    icon: <Bike className="h-3 w-3" />,
  },
  delivered: {
    label: "Delivered",
    color: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
    icon: <CheckCircle2 className="h-3 w-3" />,
  },
  cancelled: {
    label: "Cancelled",
    color: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-400",
    icon: <AlertCircle className="h-3 w-3" />,
  },
};

// Next valid status for seller actions
const nextSellerStatus: Partial<Record<OrderStatus, OrderStatus>> = {
  placed: "accepted",
  accepted: "preparing",
  preparing: "ready_for_rider",
};

function StatusBadge({ status }: { status: OrderStatus }) {
  const config = statusConfig[status] || statusConfig.placed;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${config.color}`}
    >
      {config.icon}
      {config.label}
    </span>
  );
}

function OrderCard({
  order,
  onStatusUpdate,
  isUpdating,
}: {
  order: IOrder;
  onStatusUpdate: (orderId: string, status: string) => void;
  isUpdating: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const nextStatus = nextSellerStatus[order.status];
  const createdAt = new Date(order.createdAt || "");
  const timeAgo = getTimeAgo(createdAt);

  return (
    <GlassCard className="p-4">
      <div className="flex items-start justify-between gap-4">
        {/* Left: Order Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-mono text-muted-foreground">
              #{order._id.slice(-6).toUpperCase()}
            </span>
            <StatusBadge status={order.status} />
            <span className="text-xs text-muted-foreground">{timeAgo}</span>
          </div>

          <div className="flex items-baseline gap-3 mt-1">
            <span className="text-lg font-bold flex items-center gap-0.5">
              <IndianRupee className="h-4 w-4" />
              {order.totalAmount}
            </span>
            <span className="text-xs text-muted-foreground">
              {order.items.length} item(s)
            </span>
          </div>

          {/* Items Preview */}
          <div className="mt-2 space-y-1">
            {order.items.slice(0, expanded ? undefined : 2).map((item, i) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <span className="text-foreground/80">
                  <span className="text-muted-foreground mr-1">×{item.quantity}</span>
                  {item.name}
                </span>
                <span className="text-xs text-muted-foreground">
                  ₹{item.price * item.quantity}
                </span>
              </div>
            ))}
            {order.items.length > 2 && !expanded && (
              <button
                onClick={() => setExpanded(true)}
                className="text-xs text-primary hover:underline flex items-center gap-1 mt-1"
              >
                +{order.items.length - 2} more <ChevronDown className="h-3 w-3" />
              </button>
            )}
            {expanded && (
              <button
                onClick={() => setExpanded(false)}
                className="text-xs text-primary hover:underline flex items-center gap-1 mt-1"
              >
                Show less <ChevronUp className="h-3 w-3" />
              </button>
            )}
          </div>

          {/* Delivery Address */}
          {expanded && (
            <div className="mt-3 space-y-2 pt-3 border-t border-border/40">
              <div className="flex items-start gap-2 text-xs text-muted-foreground">
                <MapPin className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>{order.deliveryAddress?.formattedAddress}</span>
              </div>
              {order.deliveryAddress?.mobile && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Phone className="h-3.5 w-3.5 shrink-0" />
                  <span>{order.deliveryAddress.mobile}</span>
                </div>
              )}
              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                <span>Subtotal: ₹{order.subtotal}</span>
                {order.deliveryFee > 0 && <span>Delivery: ₹{order.deliveryFee}</span>}
                <span>Fee: ₹{order.platformFee}</span>
              </div>
              {order.riderName && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Bike className="h-3.5 w-3.5 shrink-0" />
                  <span>
                    Rider: {order.riderName}
                    {order.riderPhone && ` · ${order.riderPhone}`}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right: Action Button */}
        <div className="shrink-0">
          {nextStatus && (
            <button
              onClick={() => onStatusUpdate(order._id, nextStatus)}
              disabled={isUpdating}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:brightness-110 transition-all disabled:opacity-50"
            >
              {isUpdating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : nextStatus === "accepted" ? (
                <CheckCircle2 className="h-3.5 w-3.5" />
              ) : nextStatus === "preparing" ? (
                <CookingPot className="h-3.5 w-3.5" />
              ) : (
                <Bike className="h-3.5 w-3.5" />
              )}
              {nextStatus === "accepted"
                ? "Accept"
                : nextStatus === "preparing"
                ? "Start Preparing"
                : "Mark Ready"}
            </button>
          )}
        </div>
      </div>
    </GlassCard>
  );
}

function getTimeAgo(date: Date): string {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function SellerOrdersPage() {
  const { data: restaurant, isLoading: loadingRestaurant } = useGetMyRestaurant();
  const {
    data: orders,
    isLoading,
    refetch,
  } = useGetRestaurantOrders(restaurant?._id || "");
  const updateStatus = useUpdateOrderStatus();

  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const handleStatusUpdate = async (orderId: string, status: string) => {
    setUpdatingId(orderId);
    try {
      await updateStatus.mutateAsync({ orderId, status });
      refetch();
    } finally {
      setUpdatingId(null);
    }
  };

  // Split orders into active (not delivered/cancelled) and completed
  const activeOrders =
    orders?.filter(
      (o) => o.status !== "delivered" && o.status !== "cancelled" && o.status !== "rider_assigned" && o.status !== "picked_up",
    ) || [];
  const completedOrders =
    orders?.filter(
      (o) => o.status === "delivered" || o.status === "cancelled" || o.status === "rider_assigned" || o.status === "picked_up",
    ) || [];

  if (loadingRestaurant) {
    return (
      <RoleGuard allowedRoles={["seller"]}>
        <div className="flex items-center justify-center py-32">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </RoleGuard>
    );
  }

  if (!restaurant) {
    return (
      <RoleGuard allowedRoles={["seller"]}>
        <div className="flex flex-col items-center justify-center py-32 text-center">
          <AlertCircle className="h-12 w-12 text-destructive mb-4" />
          <h3 className="text-lg font-semibold mb-2">No Restaurant Found</h3>
          <p className="text-muted-foreground">
            Register your restaurant first in Settings.
          </p>
        </div>
      </RoleGuard>
    );
  }

  // Listen for rider assignment events to auto-refresh
  useSocketEvent(
    SOCKET_EVENTS.RIDER_ASSIGNED,
    useCallback(
      (payload: unknown) => {
        const data = payload as RiderAssignedPayload;
        if (data?.order?.restaurantId === restaurant?._id) {
          refetch();
        }
      },
      [refetch, restaurant?._id],
    ),
  );

  const [notification, setNotification] = useState<string | null>(null);

  return (
    <RoleGuard allowedRoles={["seller"]}>
      <div className="space-y-6">
        {/* Socket Notification Banner */}
        {notification && (
          <div className="flex items-center gap-3 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm font-medium text-primary animate-in slide-in-from-top-2">
            <Bell className="h-4 w-4 shrink-0" />
            <span>{notification}</span>
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold">Orders</h2>
            <p className="text-sm text-muted-foreground mt-1">
              {orders?.length || 0} total · {activeOrders.length} active
            </p>
          </div>
          <button
            onClick={() => refetch()}
            disabled={isLoading}
            className="inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2 text-sm font-medium hover:bg-accent transition-all"
          >
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Clock className="h-4 w-4" />
            )}
            Refresh
          </button>
        </div>

        {/* Active Orders */}
        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : orders && orders.length > 0 ? (
          <>
            {activeOrders.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                  Active Orders ({activeOrders.length})
                </h3>
                {activeOrders.map((order) => (
                  <OrderCard
                    key={order._id}
                    order={order}
                    onStatusUpdate={handleStatusUpdate}
                    isUpdating={updatingId === order._id}
                  />
                ))}
              </div>
            )}

            {/* Completed Orders */}
            {completedOrders.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider pt-4 border-t border-border/40">
                  Completed ({completedOrders.length})
                </h3>
                {completedOrders.map((order) => (
                  <OrderCard
                    key={order._id}
                    order={order}
                    onStatusUpdate={handleStatusUpdate}
                    isUpdating={updatingId === order._id}
                  />
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <PackageOpen className="h-14 w-14 text-muted-foreground/20 mb-4" />
            <h3 className="text-lg font-semibold mb-2">No orders yet</h3>
            <p className="text-muted-foreground max-w-sm">
              When customers place orders, they&apos;ll appear here. Make sure your
              restaurant is marked as <strong>Open</strong> in Settings.
            </p>
          </div>
        )}
      </div>
    </RoleGuard>
  );
}
