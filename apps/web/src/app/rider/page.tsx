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
  useGetAvailableOrders,
  useAcceptOrder,
  useUpdateOrderStatus,
} from "@/features/rider/api";
import { useSocketEvent } from "@/hooks/use-socket-event";
import { useRiderLocationStream } from "@/hooks/use-rider-location-stream";
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
  Check,
  Power,
  PackageOpen,
  IndianRupee,
  Store,
  Zap,
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

  const isAvailable = rider?.isAvailable ?? false;
  const isVerified = rider?.isVerified ?? false;

  // Stream GPS to the tracking room for the whole trip — from acceptance
  // (heading to the restaurant) through pickup to delivery. NOTE: during a
  // delivery isAvailable is false (the rider is intentionally marked
  // unavailable for new offers), so availability must NOT gate streaming.
  useRiderLocationStream(currentOrder?._id, Boolean(currentOrder));

  // Offers from the server — ready orders near the rider's last known
  // location. Covers riders who logged in / refreshed after the socket
  // broadcast fired, so offers never silently disappear on login.
  const { data: availableOrders } = useGetAvailableOrders(
    Boolean(rider) && isAvailable && !currentOrder,
  );

  // Instant pop for offers broadcast while the rider is watching
  const [socketOffer, setSocketOffer] = useState<OrderAvailablePayload | null>(null);
  // Which offer's Accept button is mid-flight (per-card spinner)
  const [pendingOrderId, setPendingOrderId] = useState<string | null>(null);

  // Listen for new available orders
  useSocketEvent(
    SOCKET_EVENTS.ORDER_AVAILABLE,
    useCallback(
      (payload: unknown) => {
        const data = payload as OrderAvailablePayload;
        if (data?.orderId && !currentOrder) {
          setSocketOffer(data);
          // Auto-dismiss after 30 seconds
          setTimeout(() => setSocketOffer(null), 30000);
        }
      },
      [currentOrder],
    ),
  );

  const handleAcceptOrder = async (orderId: string) => {
    setPendingOrderId(orderId);
    try {
      await acceptOrder.mutateAsync(orderId);
      setSocketOffer(null);
      refetchOrder();
      // The accepted order leaves the available list
      queryClient.invalidateQueries({ queryKey: ["rider", "orders", "available"] });
    } catch {
      // Order may have been taken by another rider
      setSocketOffer(null);
      queryClient.invalidateQueries({ queryKey: ["rider", "orders", "available"] });
    } finally {
      setPendingOrderId(null);
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

        {/* Available offers (fetched on load + socket broadcasts) */}
        {rider && isAvailable && !currentOrder && (
          <section className="space-y-2">
            <h3 className="flex items-center justify-between px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <span>
                Available offers
                {availableOrders && availableOrders.length > 0 && (
                  <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-bold text-primary">
                    {availableOrders.length}
                  </span>
                )}
              </span>
            </h3>
            {availableOrders && availableOrders.length > 0 ? (
              availableOrders.map((order) => (
                <AvailableOrderCard
                  key={order._id}
                  order={order}
                  highlight={socketOffer?.orderId === order._id}
                  isAccepting={acceptOrder.isPending && pendingOrderId === order._id}
                  onAccept={() => handleAcceptOrder(order._id)}
                />
              ))
            ) : socketOffer ? (
              /* Socket popped an offer the list doesn't know about yet */
              <GlassCard className="animate-in slide-in-from-top-2 overflow-hidden p-0 border-2 border-primary/50 shadow-xl shadow-primary/10">
                <div className="flex items-center justify-between gap-3 bg-primary px-4 py-3 text-primary-foreground">
                  <div>
                    <p className="text-[11px] font-medium uppercase tracking-wide text-primary-foreground/70">
                      New offer just came in
                    </p>
                    <p className="text-sm font-semibold">
                      Accept before another rider does
                    </p>
                  </div>
                  <span
                    className="flex h-2.5 w-2.5 shrink-0 animate-ping rounded-full bg-white"
                    role="status"
                    aria-label="Live update"
                  />
                </div>
                <div className="px-4 py-3">
                  <Button
                    onClick={() => handleAcceptOrder(socketOffer.orderId)}
                    disabled={acceptOrder.isPending}
                    className="h-10 w-full rounded-xl text-sm shadow-sm"
                  >
                    {acceptOrder.isPending ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Accepting…
                      </>
                    ) : (
                      <>
                        <Zap className="h-4 w-4" />
                        Accept Delivery
                      </>
                    )}
                  </Button>
                  <button
                    onClick={() => setSocketOffer(null)}
                    disabled={acceptOrder.isPending}
                    className="mt-2 w-full rounded-xl py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                  >
                    Dismiss
                  </button>
                </div>
              </GlassCard>
            ) : (
              <p className="px-1 text-sm text-muted-foreground">
                No offers right now — you&apos;ll see one here the moment a
                nearby restaurant marks an order ready.
              </p>
            )}
          </section>
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
    <GlassCard className="overflow-hidden p-0">
      {/* Payout banner — mirrors the offer card */}
      <div className="flex items-center justify-between gap-3 bg-muted/60 px-4 py-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            You earn
          </p>
          <p className="flex items-center text-lg font-bold leading-tight text-foreground">
            <IndianRupee className="h-4 w-4" />
            {order.riderAmount}
          </p>
        </div>
        {order.distance ? (
          <span className="shrink-0 rounded-full bg-background px-2.5 py-1 text-[11px] font-semibold text-muted-foreground">
            {order.distance.toFixed(1)} km
          </span>
        ) : null}
      </div>

      {/* Trip route — doubles as progress: the pickup node checks off */}
      <div className="space-y-2.5 px-4 py-3.5">
        <div className="flex items-start gap-2.5">
          {isPickedUp ? (
            <span
              className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-600 dark:bg-emerald-500"
              aria-hidden="true"
            >
              <Check className="h-2.5 w-2.5 text-white" />
            </span>
          ) : (
            <span
              className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 border-primary bg-primary/10"
              aria-hidden="true"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-primary" />
            </span>
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-medium leading-tight">
              {order.restaurantName}
            </p>
            <p
              className={`text-[11px] ${
                isPickedUp
                  ? "font-medium text-emerald-600 dark:text-emerald-400"
                  : "text-muted-foreground"
              }`}
            >
              Order #{order._id.slice(-6)}
              {isPickedUp ? " · Picked up" : " · Pickup"}
            </p>
          </div>
        </div>
        <div className="ml-[7px] h-3 w-px bg-border" aria-hidden="true" />
        <div className="flex items-start gap-2.5">
          <MapPin
            className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium leading-tight">
              {order.deliveryAddress?.formattedAddress || "Delivery address in app"}
            </p>
            <p className="text-[11px] text-muted-foreground">Drop off</p>
          </div>
        </div>
      </div>

      {/* Action — full width, same weight as the offer accept button */}
      <div className="border-t border-border/60 px-4 py-3">
        <Button
          onClick={onUpdate}
          disabled={isUpdating}
          className="h-10 w-full rounded-xl text-sm shadow-sm"
        >
          {isUpdating ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Updating…
            </>
          ) : isPickedUp ? (
            <>
              <CheckCircle2 className="h-4 w-4" />
              Mark Delivered
            </>
          ) : (
            <>
              <Package className="h-4 w-4" />
              Mark Picked Up
            </>
          )}
        </Button>
      </div>
    </GlassCard>
  );
}

// ─── Available Offer Card — payout-first, built for a 3-second decision ──

function formatWaitTime(createdAt?: string): string | null {
  if (!createdAt) return null;
  const mins = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 60000));
  if (mins < 1) return "Just ready";
  if (mins < 60) return `Waiting ${mins}m`;
  const h = Math.floor(mins / 60);
  return `Waiting ${h}h ${mins % 60}m`;
}

function AvailableOrderCard({
  order,
  highlight,
  isAccepting,
  onAccept,
}: {
  order: IOrder;
  highlight: boolean;
  isAccepting: boolean;
  onAccept: () => void;
}) {
  const wait = formatWaitTime(order.createdAt);

  return (
    <GlassCard
      className={`animate-in slide-in-from-top-2 overflow-hidden p-0 transition-shadow ${
        highlight
          ? "border-2 border-primary/50 shadow-xl shadow-primary/10"
          : ""
      }`}
    >
      {/* Payout banner — the decision lives here */}
      <div
        className={`flex items-center justify-between gap-3 px-4 py-3 ${
          highlight
            ? "bg-primary text-primary-foreground"
            : "bg-muted/60"
        }`}
      >
        <div className="min-w-0">
          <p
            className={`text-[11px] font-medium uppercase tracking-wide ${
              highlight ? "text-primary-foreground/70" : "text-muted-foreground"
            }`}
          >
            You earn
          </p>
          <p
            className={`flex items-center text-lg font-bold leading-tight ${
              highlight ? "text-primary-foreground" : "text-foreground"
            }`}
          >
            <IndianRupee className="h-4 w-4" />
            {order.riderAmount}
          </p>
        </div>
        {wait && (
          <span
            className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
              highlight
                ? "bg-white/20 text-primary-foreground"
                : "bg-background text-muted-foreground"
            }`}
          >
            {wait}
          </span>
        )}
      </div>

      {/* Trip route: pickup → dropoff */}
      <div className="space-y-2.5 px-4 py-3.5">
        <div className="flex items-start gap-2.5">
          <Store className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium leading-tight">
              {order.restaurantName}
            </p>
            <p className="text-[11px] text-muted-foreground">Pickup</p>
          </div>
        </div>
        <div
          className="ml-[7px] h-3 w-px bg-border"
          aria-hidden="true"
        />
        <div className="flex items-start gap-2.5">
          <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium leading-tight">
              {order.deliveryAddress?.formattedAddress || "Delivery address in app"}
            </p>
            <p className="text-[11px] text-muted-foreground">Drop off</p>
          </div>
        </div>
      </div>

      {/* Action */}
      <div className="border-t border-border/60 px-4 py-3">
        <Button
          onClick={onAccept}
          disabled={isAccepting}
          className="h-10 w-full rounded-xl text-sm shadow-sm"
        >
          {isAccepting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Accepting…
            </>
          ) : (
            <>
              <Zap className="h-4 w-4" />
              Accept — ₹{order.riderAmount}
            </>
          )}
        </Button>
      </div>
    </GlassCard>
  );
}

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
