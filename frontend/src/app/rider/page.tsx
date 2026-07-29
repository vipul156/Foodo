// ============================================================
// Foodo — Rider Dashboard Page (/rider)
// ============================================================

"use client";

import { useState, useCallback } from "react";
import { GlassCard } from "@/components/shared/glass-card";
import { RoleGuard } from "@/components/shared/role-guard";
import {
  useGetRiderProfile,
  useToggleRiderAvailability,
  useGetCurrentOrder,
  useAcceptOrder,
} from "@/features/rider/api";
import { useSocketEvent } from "@/hooks/use-socket-event";
import { useAuthStore } from "@/store/auth-store";
import {
  SOCKET_EVENTS,
  type OrderAvailablePayload,
} from "@/lib/socket-events";
import { Button } from "@/components/ui/button";
import {
  Navigation,
  Bell,
  Package,
  Bike,
  MapPin,
  Loader2,
} from "lucide-react";

export default function RiderDashboardPage() {
  const { user } = useAuthStore();
  const { data: rider, isLoading: riderLoading, refetch: refetchProfile } = useGetRiderProfile();
  const {
    data: currentOrder,
    isLoading: orderLoading,
    refetch: refetchOrder,
  } = useGetCurrentOrder();
  const toggleAvailability = useToggleRiderAvailability();
  const acceptOrder = useAcceptOrder();

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
      refetchProfile();
    } catch {
      // Order may have been taken by another rider
      setAvailableOrder(null);
    }
  };

  const isAvailable = rider?.isAvailable ?? false;
  const isVerified = rider?.isVerified ?? false;

  const handleToggleAvailability = () => {
    // TODO: Use browser Geolocation API to get real coordinates
    // navigator.geolocation.getCurrentPosition((pos) => { ... })
    toggleAvailability.mutate({
      isAvailable: !isAvailable,
      latitude: 0,
      longitude: 0,
    });
  };

  return (
    <RoleGuard allowedRoles={["rider"]}>
      <div className="space-y-6 pb-6">
        {/* Status Banner */}
        <div
          className={`rounded-2xl p-6 text-white transition-colors ${
            isAvailable
              ? "bg-gradient-to-br from-emerald-500 to-emerald-600 dark:from-emerald-600 dark:to-emerald-800"
              : "bg-gradient-to-br from-amber-500 to-amber-600 dark:from-amber-600 dark:to-amber-800"
          }`}
        >
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-sm text-white/80">Status</p>
              <p className="text-xl font-bold">
                {riderLoading
                  ? "Loading..."
                  : isAvailable
                    ? "Available"
                    : "Offline"}
              </p>
            </div>
            <button
              onClick={handleToggleAvailability}
              disabled={toggleAvailability.isPending || !isVerified}
              className="flex h-12 w-12 items-center justify-center rounded-full bg-white/20 hover:bg-white/30 transition-colors disabled:opacity-50"
              aria-label="Toggle availability"
            >
              <Navigation className="h-6 w-6" />
            </button>
          </div>
          <p className="text-sm text-white/80">
            {!isVerified
              ? "Your rider profile is pending verification"
              : isAvailable
                ? "You are online and ready to accept deliveries"
                : "Tap the icon to go online"}
          </p>
          {!riderLoading && !rider && (
            <p className="mt-2 text-sm text-white/60">
              Complete your rider profile to start delivering
            </p>
          )}
        </div>

        {/* Available Order Notification (from socket) */}
        {availableOrder && !currentOrder && (
          <GlassCard className="border-2 border-primary/40 bg-gradient-to-br from-primary/5 to-transparent animate-in slide-in-from-top-2">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-primary">New Order Available! 🎯</h3>
              <span className="animate-pulse flex h-2 w-2 rounded-full bg-primary" />
            </div>
            <p className="text-sm text-muted-foreground mb-4">
              A new delivery order is available near you. Tap to accept!
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

        {/* Current Order */}
        <GlassCard>
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold">Active Delivery</h3>
            <Bell className="h-4 w-4 text-muted-foreground" />
          </div>

          {orderLoading ? (
            <div className="rounded-xl bg-muted/50 p-4 text-center">
              <p className="text-sm text-muted-foreground">Loading...</p>
            </div>
          ) : currentOrder ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between rounded-xl bg-muted/50 p-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                    <Package className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">
                      Order #{currentOrder._id.slice(-6)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {currentOrder.restaurantName}
                    </p>
                  </div>
                </div>
                <span className="text-sm font-medium">
                  ₹{currentOrder.riderAmount}
                </span>
              </div>

              <div className="flex items-center gap-2 rounded-xl bg-muted/50 p-3 text-xs text-muted-foreground">
                <MapPin className="h-3.5 w-3.5" />
                <span>
                  {currentOrder.deliveryAddress?.formattedAddress ||
                    "Delivery address available in app"}
                </span>
              </div>

              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Bike className="h-3.5 w-3.5" />
                <span>{currentOrder.distance?.toFixed(1) || "-"} km away</span>
              </div>
            </div>
          ) : (
            <div className="rounded-xl bg-muted/50 p-4 text-center">
              <p className="text-3xl mb-2">🛵</p>
              <p className="text-sm font-medium">No active deliveries</p>
              <p className="text-xs text-muted-foreground mt-1">
                Waiting for new orders...
              </p>
            </div>
          )}
        </GlassCard>
      </div>
    </RoleGuard>
  );
}
