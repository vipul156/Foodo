// ============================================================
// Foodo — Rider Dashboard Page (/rider)
// ============================================================

"use client";

import { useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { GlassCard } from "@/components/shared/glass-card";
import { RoleGuard } from "@/components/shared/role-guard";
import {
  useGetRiderProfile,
  useGetRiderDeliveryHistory,
  useToggleRiderAvailability,
  useGetCurrentOrder,
  useAcceptOrder,
  useUpdateOrderStatus,
} from "@/features/rider/api";
import { useSocketEvent } from "@/hooks/use-socket-event";
import {
  SOCKET_EVENTS,
  type OrderAvailablePayload,
} from "@/lib/socket-events";
import { Button } from "@/components/ui/button";
import type { IOrder } from "@/types";
import {
  Package,
  MapPin,
  Loader2,
  CheckCircle2,
  ChevronRight,
  Power,
  PackageOpen,
  IndianRupee,
} from "lucide-react";

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export default function RiderDashboardPage() {
  const { data: rider, isLoading: riderLoading } = useGetRiderProfile();
  const { data: history } = useGetRiderDeliveryHistory();
  const {
    data: currentOrder,
    isLoading: orderLoading,
    refetch: refetchOrder,
  } = useGetCurrentOrder();
  const toggleAvailability = useToggleRiderAvailability();
  const acceptOrder = useAcceptOrder();
  const updateOrderStatus = useUpdateOrderStatus();
  const queryClient = useQueryClient();

  // Available order notification from socket
  const [availableOrder, setAvailableOrder] = useState<OrderAvailablePayload | null>(null);

  // Listen for new available orders
  useSocketEvent(
    SOCKET_EVENTS.ORDER_AVAILABLE,
    useCallback(
      (payload: unknown) => {
        const data = payload as OrderAvailablePayload;
        if (data?.orderId && !currentOrder) {
          setAvailableOrder(data);
          // Auto-dismiss after 30 seconds
          setTimeout(() => setAvailableOrder(null), 30000);
        }
      },
      [currentOrder],
    ),
  );

  const handleAcceptOrder = async () => {
    if (!availableOrder?.orderId) return;
    try {
      await acceptOrder.mutateAsync(availableOrder.orderId);
      setAvailableOrder(null);
      refetchOrder();
    } catch {
      // Order may have been taken by another rider
      setAvailableOrder(null);
    }
  };

  const handleUpdateOrderStatus = async () => {
    if (!currentOrder?._id) return;
    try {
      await updateOrderStatus.mutateAsync({ orderId: currentOrder._id });
      // Order flips to picked_up / delivered — refresh card + availability
      queryClient.invalidateQueries({ queryKey: ["rider", "order", "current"] });
      queryClient.invalidateQueries({ queryKey: ["rider", "profile"] });
      // A delivered order also lands in the history feed
      queryClient.invalidateQueries({ queryKey: ["rider", "history"] });
    } catch {
      // Error is surfaced by the mutation hook
    }
  };

  const isAvailable = rider?.isAvailable ?? false;
  const isVerified = rider?.isVerified ?? false;

  const handleToggleAvailability = () => {
    if (!navigator.geolocation) {
      toggleAvailability.mutate({
        isAvailable: !isAvailable,
        latitude: 0,
        longitude: 0,
      });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        toggleAvailability.mutate({
          isAvailable: !isAvailable,
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
        });
      },
      () => {
        // Geolocation denied or unavailable — fall back to 0,0
        toggleAvailability.mutate({
          isAvailable: !isAvailable,
          latitude: 0,
          longitude: 0,
        });
      },
      { enableHighAccuracy: true, timeout: 8000 },
    );
  };

  // Today's completed deliveries — the number a rider checks between trips
  const todayStats = useMemo(() => {
    const orders = history || [];
    const today = new Date();
    const todays = orders.filter(
      (o) => o.createdAt && isSameDay(new Date(o.createdAt), today),
    );
    return {
      total: todays.reduce((sum, o) => sum + (o.riderAmount || 0), 0),
      count: todays.length,
    };
  }, [history]);

  return (
    <RoleGuard allowedRoles={["rider"]}>
      <div className="space-y-4 pb-6">
        {/* Duty status */}
        {riderLoading ? (
          <div className="h-28 animate-pulse rounded-2xl bg-muted/60" />
        ) : !rider ? (
          <NoProfileCard />
        ) : (
          <DutyCard
            isAvailable={isAvailable}
            isVerified={isVerified}
            isPending={toggleAvailability.isPending}
            onToggle={handleToggleAvailability}
          />
        )}

        {/* Today at a glance */}
        {rider && (
          <TodayStrip total={todayStats.total} count={todayStats.count} />
        )}

        {/* Available Order Notification (from socket) */}
        {availableOrder && !currentOrder && rider && (
          <GlassCard className="animate-in slide-in-from-top-2 border-2 border-primary/40 p-4">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="font-semibold text-primary">New order available</h3>
              <span
                className="flex h-2 w-2 animate-ping rounded-full bg-primary"
                role="status"
                aria-label="Live update"
              />
            </div>
            <p className="mb-4 text-sm text-muted-foreground">
              A delivery order is available near you. Accept it before another
              rider does.
            </p>
            <div className="flex gap-3">
              <Button
                onClick={handleAcceptOrder}
                disabled={acceptOrder.isPending}
                className="flex-1"
              >
                {acceptOrder.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Accept Delivery"
                )}
              </Button>
              <Button
                variant="outline"
                onClick={() => setAvailableOrder(null)}
                disabled={acceptOrder.isPending}
              >
                Dismiss
              </Button>
            </div>
          </GlassCard>
        )}

        {/* Active delivery or listening state */}
        <section className="space-y-2">
          <h3 className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Active delivery
          </h3>
          {orderLoading ? (
            <div className="h-44 animate-pulse rounded-2xl bg-muted/60" />
          ) : currentOrder ? (
            <DeliveryCard
              order={currentOrder}
              isUpdating={updateOrderStatus.isPending}
              onUpdate={handleUpdateOrderStatus}
            />
          ) : (
            <ListeningState isAvailable={isAvailable} />
          )}
        </section>
      </div>
    </RoleGuard>
  );
}

// ─── Duty Card — go online / offline ─────────────────────────

function DutyCard({
  isAvailable,
  isVerified,
  isPending,
  onToggle,
}: {
  isAvailable: boolean;
  isVerified: boolean;
  isPending: boolean;
  onToggle: () => void;
}) {
  return (
    <section
      className={`rounded-2xl border p-5 transition-colors ${
        isAvailable
          ? "border-emerald-600 bg-emerald-600 text-white"
          : "border-border bg-muted/40"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {isAvailable ? (
              <span className="relative flex h-2.5 w-2.5 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-60" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-white" />
              </span>
            ) : (
              <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-muted-foreground/50" />
            )}
            <p className="text-sm font-semibold">
              {isAvailable ? "Online" : "Offline"}
            </p>
          </div>
          <p
            className={`mt-1.5 text-sm ${
              isAvailable ? "text-white/85" : "text-muted-foreground"
            }`}
          >
            {!isVerified
              ? "Your rider profile is pending verification"
              : isAvailable
                ? "Ready to accept deliveries near you"
                : "Go online to start receiving delivery offers"}
          </p>
        </div>

        <button
          type="button"
          onClick={onToggle}
          disabled={isPending || !isVerified}
          className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl px-3.5 text-xs font-semibold transition-all active:scale-[0.97] disabled:opacity-60 ${
            isAvailable
              ? "bg-white/15 text-white hover:bg-white/25"
              : "bg-primary text-primary-foreground shadow-lg shadow-primary/25 hover:brightness-110"
          }`}
        >
          {isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Power className="h-3.5 w-3.5" />
          )}
          {isAvailable ? "Go offline" : "Go online"}
        </button>
      </div>
    </section>
  );
}

// ─── No Profile Yet ──────────────────────────────────────────

function NoProfileCard() {
  return (
    <section className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-5">
      <p className="font-semibold">Finish setting up your rider profile</p>
      <p className="mt-1 text-sm text-muted-foreground">
        Add your details and get verified to start delivering.
      </p>
      <Link href="/rider/profile" className="mt-3 inline-block">
        <Button size="sm">Complete profile</Button>
      </Link>
    </section>
  );
}

// ─── Today Strip — earnings + deliveries ─────────────────────

function TodayStrip({ total, count }: { total: number; count: number }) {
  return (
    <Link href="/rider/earnings" className="grid grid-cols-2 gap-4">
      <GlassCard hover className="p-4">
        <p className="text-xs font-medium text-muted-foreground">Earned today</p>
        <p className="mt-1.5 flex items-center text-xl font-bold">
          <IndianRupee className="h-4.5 w-4.5" />
          {total}
        </p>
      </GlassCard>
      <GlassCard hover className="p-4">
        <p className="text-xs font-medium text-muted-foreground">
          Deliveries today
        </p>
        <p className="mt-1.5 text-xl font-bold">{count}</p>
      </GlassCard>
    </Link>
  );
}

// ─── Active Delivery Card ────────────────────────────────────

function DeliveryCard({
  order,
  isUpdating,
  onUpdate,
}: {
  order: IOrder;
  isUpdating: boolean;
  onUpdate: () => void;
}) {
  const isPickedUp = order.status === "picked_up";

  return (
    <GlassCard className="p-4">
      <div className="space-y-3">
        <div className="flex items-center justify-between rounded-xl bg-muted/50 p-3.5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
              <Package className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="text-sm font-semibold">
                Order #{order._id.slice(-6)}
              </p>
              <p className="text-xs text-muted-foreground">
                {order.restaurantName}
                {order.distance ? ` · ${order.distance.toFixed(1)} km` : ""}
              </p>
            </div>
          </div>
          <span className="flex items-center text-sm font-bold">
            <IndianRupee className="h-3.5 w-3.5" />
            {order.riderAmount}
          </span>
        </div>

        <div className="flex items-start gap-2 rounded-xl bg-muted/50 p-3 text-xs text-muted-foreground">
          <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {order.deliveryAddress?.formattedAddress ||
              "Delivery address available in app"}
          </span>
        </div>

        {/* Progress + rider action */}
        <div className="flex items-center justify-between gap-3 rounded-xl border border-border/60 p-3">
          <div className="flex items-center gap-2 text-xs font-medium">
            <span
              className={`inline-flex items-center gap-1 ${
                isPickedUp
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-foreground"
              }`}
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              Picked up
            </span>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">Delivered</span>
          </div>
          <Button size="sm" onClick={onUpdate} disabled={isUpdating}>
            {isUpdating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                <CheckCircle2 className="h-3.5 w-3.5" />
                {isPickedUp ? "Mark Delivered" : "Mark Picked Up"}
              </>
            )}
          </Button>
        </div>
      </div>
    </GlassCard>
  );
}

// ─── Listening / Offline Empty State ─────────────────────────

function ListeningState({ isAvailable }: { isAvailable: boolean }) {
  return (
    <GlassCard className="flex flex-col items-center justify-center px-6 py-10 text-center">
      {isAvailable ? (
        <>
          <span className="relative mb-4 flex h-3 w-3">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-50" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-primary" />
          </span>
          <p className="font-semibold">Listening for orders</p>
          <p className="mt-1 max-w-xs text-sm text-muted-foreground">
            The moment a restaurant near you marks an order ready, it pops up
            here. Stay online to keep receiving offers.
          </p>
        </>
      ) : (
        <>
          <PackageOpen className="mb-4 h-10 w-10 text-muted-foreground/40" />
          <p className="font-semibold">No active deliveries</p>
          <p className="mt-1 max-w-xs text-sm text-muted-foreground">
            You&apos;re offline. Go online to start receiving delivery offers.
          </p>
        </>
      )}
    </GlassCard>
  );
}
