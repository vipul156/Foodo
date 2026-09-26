// ============================================================
// Foodo — Order Detail Page (/orders/[id])
// ============================================================
// Full receipt view for one order: every item with its image,
// quantity and line price, the complete bill, the delivery
// address, rider contact when assigned, and the live tracking
// map while the trip is running (static pins once delivered).

"use client";

import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import { GlassCard } from "@/components/shared/glass-card";
import { useGetOrder, useCancelOrder } from "@/features/orders/api";
import { LiveTracking } from "@/features/tracking/components";
import { useSocketEvent } from "@/hooks/use-socket-event";
import { SOCKET_EVENTS, type OrderUpdatePayload } from "@/lib/socket-events";
import { useAuthStore } from "@/store/auth-store";
import type { IOrder, IOrderItem } from "@/types";
import {
  ArrowLeft,
  Loader2,
  AlertCircle,
  IndianRupee,
  MapPin,
  Phone,
  Bike,
  CreditCard,
  Banknote,
  Navigation,
  XCircle,
  UtensilsCrossed,
} from "lucide-react";

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

const statusTone: Record<string, string> = {
  delivered: "bg-emerald-600/10 text-emerald-700 dark:text-emerald-400",
  cancelled: "bg-destructive/10 text-destructive",
  rider_assigned: "bg-cyan-600/10 text-cyan-700 dark:text-cyan-400",
  picked_up: "bg-emerald-600/10 text-emerald-700 dark:text-emerald-400",
};

/** Map shows while the trip runs; delivered keeps it as a static recap. */
function isLiveTrip(order: IOrder): boolean {
  return order.status === "rider_assigned" || order.status === "picked_up";
}

/** Legacy orders stored a photo URL in riderName — don't render it as text. */
function isHttpUrl(value: string | null | undefined): boolean {
  return Boolean(value && /^https?:\/\//i.test(value));
}

export default function OrderDetailPage() {
  const params = useParams();
  const router = useRouter();
  const orderId = params.id as string;
  const { user } = useAuthStore();
  const { data: order, isLoading, error, refetch } = useGetOrder(orderId);
  const cancelOrder = useCancelOrder();

  // Order lifecycle events refresh this page instantly (status badge,
  // rider block, map mode) without a manual reload.
  useSocketEvent(
    SOCKET_EVENTS.ORDER_UPDATE,
    (payload: unknown) => {
      const data = payload as OrderUpdatePayload;
      if (data?.orderId === orderId) refetch();
    },
  );

  if (isLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !order) {
    return (
      <Shell>
        <EmptyState
          icon={<AlertCircle className="h-12 w-12 text-destructive" />}
          title="Order not found"
          description="This order doesn't exist or belongs to another account."
        />
      </Shell>
    );
  }

  const live = isLiveTrip(order);
  const canCancel =
    order.status === "placed" || order.status === "accepted" || order.status === "preparing";

  return (
    <Shell>
      {/* Header */}
      <div className="mb-6 flex items-center gap-4">
        <button
          onClick={() => router.back()}
          className="flex h-10 w-10 items-center justify-center rounded-xl border border-border hover:bg-accent transition-all"
          aria-label="Go back"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold">{order.restaurantName}</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Order #{order._id.slice(-8).toUpperCase()}
            {order.createdAt &&
              ` · ${new Date(order.createdAt).toLocaleString("en-IN", {
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              })}`}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${
            statusTone[order.status] || "bg-muted text-foreground"
          }`}
        >
          {statusLabels[order.status] || order.status}
        </span>
      </div>

      {/* Live tracking — only while the trip is running. Delivered orders
          keep no route history (pings are transient), so a post-delivery map
          would be two static pins pretending to be a recap. */}
      {order.restaurantLocation && order.deliveryAddress && live && (
        <section className="mb-6">
          <SectionTitle icon={<Navigation className="h-4 w-4" />}>
            Live tracking
          </SectionTitle>
          <LiveTracking
            orderId={order._id}
            restaurant={{
              name: order.restaurantName,
              latitude: order.restaurantLocation.latitude,
              longitude: order.restaurantLocation.longitude,
            }}
            dropoff={{
              formattedAddress: order.deliveryAddress.formattedAddress,
              latitude: order.deliveryAddress.latitude,
              longitude: order.deliveryAddress.longitude,
            }}
          />
        </section>
      )}

      {/* Rider card — only while the delivery is in motion; delivered and
          cancelled orders have no rider to contact anymore */}
      {order.riderId && isLiveTrip(order) && (
        <section className="mb-6">
          <SectionTitle icon={<Bike className="h-4 w-4" />}>Your rider</SectionTitle>
          <GlassCard className="flex items-center gap-4 p-4">
            {/* Avatar: rider photo when available (also recovers legacy orders
                that stored the photo URL in riderName), initials otherwise */}
            <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/10">
              {(() => {
                const pic = order.riderPicture || (isHttpUrl(order.riderName) ? order.riderName : null);
                if (pic) {
                  return <img src={pic} alt="Rider" className="h-full w-full object-cover" />;
                }
                return <Bike className="h-5 w-5 text-primary" />;
              })()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">
                {isHttpUrl(order.riderName) ? "Delivery Partner" : order.riderName || "Delivery Partner"}
              </p>
              <p className="text-xs text-muted-foreground">
                {order.status === "picked_up" ? "On the way to you" : "Heading to the restaurant"}
              </p>
            </div>
            {order.riderPhone && (
              <a
                href={`tel:${order.riderPhone}`}
                className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-border px-4 text-xs font-medium hover:bg-accent transition-colors"
              >
                <Phone className="h-3.5 w-3.5" />
                Call
              </a>
            )}
          </GlassCard>
        </section>
      )}

      {/* Items */}
      <section className="mb-6">
        <SectionTitle icon={<UtensilsCrossed className="h-4 w-4" />}>
          {order.items.length} item{order.items.length !== 1 ? "s" : ""}
        </SectionTitle>
        <GlassCard className="overflow-hidden p-0">
          <ul className="divide-y divide-border/60">
            {order.items.map((item: IOrderItem, idx: number) => (
              <li key={item.itemId || idx} className="flex items-center gap-4 p-4">
                {/* Item image */}
                <div className="h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-muted">
                  {item.image ? (
                    <img
                      src={item.image}
                      alt={item.name}
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center">
                      <UtensilsCrossed className="h-6 w-6 text-muted-foreground/40" />
                    </div>
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{item.name}</p>
                  <p className="mt-0.5 flex items-center text-xs text-muted-foreground">
                    <IndianRupee className="h-3 w-3" />
                    {item.price} × {item.quantity}
                  </p>
                </div>

                <span className="flex shrink-0 items-center text-sm font-semibold">
                  <IndianRupee className="h-3.5 w-3.5" />
                  {item.price * item.quantity}
                </span>
              </li>
            ))}
          </ul>

          {/* Bill */}
          <div className="space-y-1.5 border-t border-border/60 bg-muted/30 p-4 text-sm">
            <BillRow label="Item total" value={order.subtotal} />
            <BillRow
              label="Delivery fee"
              value={order.deliveryFee}
              free={order.deliveryFee === 0}
            />
            <BillRow label="Platform fee" value={order.platformFee} />
            <div className="flex items-center justify-between border-t border-border/60 pt-2 text-base font-bold">
              <span>Total paid</span>
              <span className="flex items-center text-primary">
                <IndianRupee className="h-4 w-4" />
                {order.totalAmount}
              </span>
            </div>
          </div>
        </GlassCard>
      </section>

      {/* Delivery address */}
      <section className="mb-6">
        <SectionTitle icon={<MapPin className="h-4 w-4" />}>Delivery address</SectionTitle>
        <GlassCard className="flex items-start gap-3 p-4">
          <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="text-sm">{order.deliveryAddress?.formattedAddress}</p>
            {order.deliveryAddress?.mobile && (
              <p className="mt-1 text-xs text-muted-foreground">
                📞 {order.deliveryAddress.mobile}
              </p>
            )}
          </div>
        </GlassCard>
      </section>

      {/* Payment + cancellation */}
      <section className="mb-10 flex flex-wrap items-center justify-between gap-3">
        <GlassCard className="flex items-center gap-3 px-4 py-3">
          {order.paymentMethod === "cod" ? (
            <Banknote className="h-4 w-4 text-muted-foreground" />
          ) : (
            <CreditCard className="h-4 w-4 text-muted-foreground" />
          )}
          <span className="text-xs font-medium">
            {order.paymentMethod === "cod"
              ? "Cash on Delivery"
              : order.paymentMethod === "stripe"
                ? "Paid via Stripe"
                : "Paid via Razorpay"}
            {" · "}
            {order.paymentStatus}
          </span>
        </GlassCard>

        {canCancel && user && (
          <button
            onClick={() => cancelOrder.mutate(order._id)}
            disabled={cancelOrder.isPending}
            className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-destructive/40 px-4 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
          >
            {cancelOrder.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <XCircle className="h-3.5 w-3.5" />
            )}
            Cancel order
          </button>
        )}
      </section>
    </Shell>
  );
}

// ─── Layout helpers ───────────────────────────────────────────

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">{children}</div>
  );
}

function SectionTitle({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      {icon}
      {children}
    </h2>
  );
}

function BillRow({
  label,
  value,
  free = false,
}: {
  label: string;
  value: number;
  free?: boolean;
}) {
  return (
    <div className="flex items-center justify-between text-muted-foreground">
      <span>{label}</span>
      {free ? (
        <span className="font-medium text-emerald-600 dark:text-emerald-400">FREE</span>
      ) : (
        <span className="flex items-center">
          <IndianRupee className="h-3 w-3" />
          {value}
        </span>
      )}
    </div>
  );
}

function EmptyState({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      {icon}
      <h2 className="mt-4 text-lg font-semibold">{title}</h2>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      <Link
        href="/orders"
        className="mt-6 inline-flex h-10 items-center justify-center rounded-xl bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
      >
        Back to My Orders
      </Link>
    </div>
  );
}
