// ============================================================
// Foodo — My Orders Page
// ============================================================

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { GlassCard } from "@/components/shared/glass-card";
import { useGetMyOrders } from "@/features/orders/api";
import { useSocketEvent } from "@/hooks/use-socket-event";
import { useAuthStore } from "@/store/auth-store";
import {
  SOCKET_EVENTS,
  type OrderUpdatePayload,
  type OrderDeliveredPayload,
} from "@/lib/socket-events";
import type { IOrder } from "@/types";
import {
  ArrowLeft,
  Package,
  Loader2,
  AlertCircle,
  ShoppingBag,
  Clock,
  IndianRupee,
  MapPin,
  CheckCircle2,
  CookingPot,
  Bike,
  XCircle,
  Bell,
} from "lucide-react";

function useOrderSocket(refetch: () => void) {
  const { user } = useAuthStore();
  const [notification, setNotification] = useState<string | null>(null);

  // Auto-dismiss notification after 4 seconds
  useEffect(() => {
    if (!notification) return;
    const timer = setTimeout(() => setNotification(null), 4000);
    return () => clearTimeout(timer);
  }, [notification]);

  // Listen for order status updates
  useSocketEvent(
    SOCKET_EVENTS.ORDER_UPDATE,
    useCallback(
      (payload: unknown) => {
        const data = payload as OrderUpdatePayload;
        if (data?.orderId) {
          refetch();
          setNotification(`Order #${data.orderId.slice(-6)} is now ${data.status}`);
        }
      },
      [refetch],
    ),
  );

  // Listen for delivery updates (rider picked up / delivered)
  useSocketEvent(
    SOCKET_EVENTS.RIDER_ASSIGNED,
    useCallback(
      (payload: unknown) => {
        refetch();
        setNotification("Your rider is on the way!");
      },
      [refetch],
    ),
  );

  // Listen for delivered event
  useSocketEvent(
    SOCKET_EVENTS.ORDER_DELIVERED,
    useCallback(
      (payload: unknown) => {
        refetch();
        setNotification("Your order has been delivered! Enjoy your meal");
      },
      [refetch],
    ),
  );

  return notification;
}

const statusIcons: Record<string, React.ReactNode> = {
  placed: <Clock className="h-4 w-4 text-blue-500" />,
  accepted: <CheckCircle2 className="h-4 w-4 text-green-500" />,
  preparing: <CookingPot className="h-4 w-4 text-orange-500" />,
  ready_for_rider: <Package className="h-4 w-4 text-purple-500" />,
  rider_assigned: <Bike className="h-4 w-4 text-cyan-500" />,
  picked_up: <Bike className="h-4 w-4 text-green-500" />,
  delivered: <CheckCircle2 className="h-4 w-4 text-emerald-500" />,
  cancelled: <XCircle className="h-4 w-4 text-red-500" />,
};

const statusLabels: Record<string, string> = {
  placed: "Order Placed",
  accepted: "Accepted",
  preparing: "Preparing",
  ready_for_rider: "Ready for Pickup",
  rider_assigned: "Rider Assigned",
  picked_up: "Picked Up",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

export default function OrdersPage() {
  const { data: orders, isLoading, error, refetch } = useGetMyOrders();
  const notification = useOrderSocket(refetch);

  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 py-8">
      {/* Socket Notification Banner */}
      {notification && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm font-medium text-primary animate-in slide-in-from-top-2">
          <Bell className="h-4 w-4 shrink-0" />
          <span>{notification}</span>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center gap-4 mb-8">
        <Link
          href="/"
          className="flex h-10 w-10 items-center justify-center rounded-xl border border-border hover:bg-accent transition-all"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold">My Orders</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Track all your orders in real-time
          </p>
        </div>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="flex items-center justify-center py-32">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : error ? (
        <div className="flex flex-col items-center justify-center py-32 text-center">
          <AlertCircle className="h-12 w-12 text-destructive mb-4" />
          <h3 className="text-lg font-semibold mb-2">Couldn&apos;t load orders</h3>
          <p className="text-muted-foreground mb-6">
            Please try again later.
          </p>
        </div>
      ) : orders && orders.length > 0 ? (
        <div className="space-y-4">
          {orders.map((order: IOrder) => (
            <OrderCard key={order._id} order={order} />
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-32 text-center">
          <ShoppingBag className="h-16 w-16 text-muted-foreground/30 mb-6" />
          <h3 className="text-xl font-semibold mb-2">No orders yet</h3>
          <p className="text-muted-foreground max-w-md mb-6">
            You haven&apos;t placed any orders yet. Browse restaurants and
            order your favorite meals!
          </p>
          <Link
            href="/restaurants"
            className="inline-flex h-10 items-center justify-center rounded-xl bg-primary px-5 text-sm font-medium text-primary-foreground hover:brightness-110 transition-all"
          >
            Browse Restaurants
          </Link>
        </div>
      )}
    </div>
  );
}

// ─── Order Card ──────────────────────────────────────────────

function OrderCard({ order }: { order: IOrder }) {
  const statusColor =
    order.status === "delivered"
      ? "border-emerald-500/30 bg-emerald-500/5"
      : order.status === "cancelled"
        ? "border-red-500/30 bg-red-500/5"
        : "border-primary/10";

  return (
    <GlassCard className={`overflow-hidden border ${statusColor}`}>
      <div className="p-5">
        {/* Header */}
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="font-semibold">{order.restaurantName}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Order #{order._id.slice(-8).toUpperCase()}
            </p>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-medium">
            {statusIcons[order.status] || <Clock className="h-4 w-4" />}
            {statusLabels[order.status] || order.status}
          </span>
        </div>

        {/* Items */}
        <div className="space-y-1 mb-3">
          {order.items?.slice(0, 3).map((item, idx) => (
            <p key={idx} className="text-sm text-muted-foreground">
              {item.quantity}x {item.name}
            </p>
          ))}
          {order.items && order.items.length > 3 && (
            <p className="text-xs text-muted-foreground">
              +{order.items.length - 3} more items
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between text-xs text-muted-foreground border-t border-border/50 pt-3">
          <span className="flex items-center gap-1">
            <IndianRupee className="h-3 w-3" />
            {order.totalAmount}
          </span>
          {order.createdAt && (
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {new Date(order.createdAt).toLocaleDateString("en-IN", {
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          )}
          {order.deliveryAddress && (
            <span className="flex items-center gap-1 truncate max-w-[120px]">
              <MapPin className="h-3 w-3 shrink-0" />
              {order.deliveryAddress.formattedAddress?.slice(0, 20)}
            </span>
          )}
        </div>
      </div>
    </GlassCard>
  );
}
