// ============================================================
// Foodo — Admin Dashboard Page (/admin) — Verification Queue
// ============================================================

"use client";

import { GlassCard } from "@/components/shared/glass-card";
import { PremiumButton } from "@/components/shared/premium-button";
import { RoleGuard } from "@/components/shared/role-guard";
import {
  useGetPendingRestaurants,
  useGetPendingRiders,
  useGetPlatformStats,
  useVerifyRestaurant,
  useVerifyRider,
} from "@/features/admin/api";
import type { IPendingRestaurant, IPendingRider } from "@/types";
import Link from "next/link";
import {
  Loader2,
  Check,
  ArrowRight,
  Store,
  Bike,
  Phone,
  CheckCircle2,
  AlertCircle,
  Users,
  IndianRupee,
  ShoppingBag,
  ChevronRight,
} from "lucide-react";

export default function AdminDashboardPage() {
  const {
    data: pendingRestaurants,
    isLoading: loadingRestaurants,
    isError: errorRestaurants,
  } = useGetPendingRestaurants();
  const {
    data: pendingRiders,
    isLoading: loadingRiders,
    isError: errorRiders,
  } = useGetPendingRiders();
  const { data: stats } = useGetPlatformStats();
  const verifyRestaurant = useVerifyRestaurant();
  const verifyRider = useVerifyRider();

  const isLoading = loadingRestaurants || loadingRiders;
  const restaurantCount = pendingRestaurants?.length ?? 0;
  const riderCount = pendingRiders?.length ?? 0;
  const totalPending =
    (errorRestaurants ? 0 : restaurantCount) + (errorRiders ? 0 : riderCount);
  const allClear = totalPending === 0 && !errorRestaurants && !errorRiders;

  return (
    <RoleGuard allowedRoles={["admin"]}>
      <div className="space-y-6">
        {/* Queue header — the count is the page's reason to exist */}
        <div>
          <h2 className="text-xl font-bold tracking-tight">Verification queue</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {isLoading
              ? "Checking for new applicants…"
              : allClear
                ? "Everything is reviewed — new signups land here"
                : `${totalPending} applicant${totalPending !== 1 ? "s" : ""} waiting for review`}
          </p>
        </div>

        {isLoading ? (
          <div className="grid gap-6 xl:grid-cols-2">
            <QueueSkeleton />
            <QueueSkeleton />
          </div>
        ) : (
          <div className="grid gap-6 xl:grid-cols-2">
            {/* Restaurants queue */}
            <QueueSection
              title="Restaurants"
              icon={Store}
              count={errorRestaurants ? null : restaurantCount}
              viewAllHref="/admin/restaurants"
              error={errorRestaurants}
            >
              {errorRestaurants ? (
                <QueueError message="Couldn't load pending restaurants." />
              ) : restaurantCount === 0 ? (
                <QueueEmpty message="No restaurants waiting" />
              ) : (
                pendingRestaurants!
                  .slice(0, 5)
                  .map((r) => (
                    <RestaurantRow
                      key={r._id}
                      restaurant={r}
                      onApprove={() => verifyRestaurant.mutate(r._id)}
                      isApproving={
                        verifyRestaurant.isPending &&
                        verifyRestaurant.variables === r._id
                      }
                    />
                  ))
              )}
            </QueueSection>

            {/* Riders queue */}
            <QueueSection
              title="Riders"
              icon={Bike}
              count={errorRiders ? null : riderCount}
              viewAllHref="/admin/riders"
              error={errorRiders}
            >
              {errorRiders ? (
                <QueueError message="Couldn't load pending riders." />
              ) : riderCount === 0 ? (
                <QueueEmpty message="No riders waiting" />
              ) : (
                pendingRiders!
                  .slice(0, 5)
                  .map((r) => (
                    <RiderRow
                      key={r._id}
                      rider={r}
                      onApprove={() => verifyRider.mutate(r._id)}
                      isApproving={
                        verifyRider.isPending && verifyRider.variables === r._id
                      }
                    />
                  ))
              )}
            </QueueSection>
          </div>
        )}

        {/* Platform pulse — fills the clear-queue state with real signal */}
        {stats && (
          <section>
            <div className="mb-3 flex items-center justify-between px-1">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Platform pulse
              </h3>
              <Link
                href="/admin/analytics"
                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                Full analytics
                <ChevronRight className="h-3.5 w-3.5" />
              </Link>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <PulseCard
                icon={IndianRupee}
                label="Gross revenue"
                value={`₹${stats.revenue.total.toLocaleString("en-IN")}`}
                sub={`${stats.orders.total.toLocaleString("en-IN")} orders all-time`}
                href="/admin/analytics"
              />
              <PulseCard
                icon={Users}
                label="Users"
                value={stats.users.total.toLocaleString("en-IN")}
                sub={`${stats.users.newThisMonth} joined this month`}
                href="/admin/users"
              />
              <PulseCard
                icon={Store}
                label="Restaurants"
                value={stats.restaurants.total.toLocaleString("en-IN")}
                sub={`${stats.restaurants.open} open now`}
                href="/admin/restaurants"
              />
              <PulseCard
                icon={Bike}
                label="Riders"
                value={stats.riders.total.toLocaleString("en-IN")}
                sub={`${stats.riders.online} online`}
                href="/admin/riders"
              />
            </div>
            {/* Live order state — the one thing an admin scans hourly */}
            <GlassCard className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-4">
              <span className="flex items-center gap-2 text-sm">
                <ShoppingBag className="h-4 w-4 text-muted-foreground" />
                <span className="font-semibold">{stats.orders.active}</span>
                <span className="text-muted-foreground">in flight</span>
              </span>
              <span className="flex items-center gap-2 text-sm">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                <span className="font-semibold">{stats.orders.delivered}</span>
                <span className="text-muted-foreground">delivered</span>
              </span>
              <span className="flex items-center gap-2 text-sm">
                <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
                <span className="font-semibold">{stats.orders.cancelled}</span>
                <span className="text-muted-foreground">cancelled</span>
              </span>
            </GlassCard>
          </section>
        )}
      </div>
    </RoleGuard>
  );
}

// ─── Queue Section shell ─────────────────────────────────────

function QueueSection({
  title,
  icon: Icon,
  count,
  viewAllHref,
  error,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  count: number | null;
  viewAllHref: string;
  error: boolean;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-3 flex items-center justify-between px-1">
        <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          <Icon className="h-4 w-4" />
          {title}
          {count !== null && (
            <span
              className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-bold ${
                count > 0
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {count}
            </span>
          )}
        </h3>
        <Link
          href={viewAllHref}
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          Manage all
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      <GlassCard className="divide-y divide-border/50 p-0">{children}</GlassCard>
    </section>
  );
}

// ─── Restaurant applicant row ────────────────────────────────

function RestaurantRow({
  restaurant,
  onApprove,
  isApproving,
}: {
  restaurant: IPendingRestaurant;
  onApprove: () => void;
  isApproving: boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      {restaurant.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={restaurant.image}
          alt=""
          aria-hidden="true"
          className="h-11 w-11 shrink-0 rounded-xl object-cover"
        />
      ) : (
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10">
          <Store className="h-5 w-5 text-primary" />
        </span>
      )}

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{restaurant.name}</p>
        <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted-foreground">
          <Phone className="h-3 w-3 shrink-0" />
          {restaurant.phone || "No contact"}
          {restaurant.description && (
            <span className="truncate">· {restaurant.description}</span>
          )}
        </p>
      </div>

      <PremiumButton
        size="sm"
        variant="primary"
        onClick={onApprove}
        disabled={isApproving}
        className="shrink-0"
        aria-label={`Approve ${restaurant.name}`}
      >
        {isApproving ? (
          <Loader2 className="h-3.5 w-3.5" />
        ) : (
          <Check className="h-3.5 w-3.5" />
        )}
        Approve
      </PremiumButton>
    </div>
  );
}

// ─── Rider applicant row ─────────────────────────────────────

function RiderRow({
  rider,
  onApprove,
  isApproving,
}: {
  rider: IPendingRider;
  onApprove: () => void;
  isApproving: boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      {rider.picture ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={rider.picture}
          alt=""
          aria-hidden="true"
          className="h-11 w-11 shrink-0 rounded-xl object-cover"
        />
      ) : (
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10">
          <Bike className="h-5 w-5 text-primary" />
        </span>
      )}

      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">
          {rider.phoneNumber || "Unknown rider"}
        </p>
        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Phone className="h-3 w-3 shrink-0" />
          Awaiting document verification
        </p>
      </div>

      <PremiumButton
        size="sm"
        variant="primary"
        onClick={onApprove}
        disabled={isApproving}
        className="shrink-0"
        aria-label={`Approve rider ${rider.phoneNumber}`}
      >
        {isApproving ? (
          <Loader2 className="h-3.5 w-3.5" />
        ) : (
          <Check className="h-3.5 w-3.5" />
        )}
        Approve
      </PremiumButton>
    </div>
  );
}

// ─── Platform pulse card ─────────────────────────────────────

function PulseCard({
  icon: Icon,
  label,
  value,
  sub,
  href,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub: string;
  href: string;
}) {
  return (
    <Link href={href}>
      <GlassCard hover className="cursor-pointer p-4">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Icon className="h-4 w-4" />
          <p className="text-xs font-medium">{label}</p>
          <ChevronRight className="ml-auto h-3.5 w-3.5" />
        </div>
        <p className="mt-1.5 text-xl font-bold tracking-tight">{value}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>
      </GlassCard>
    </Link>
  );
}

// ─── States ──────────────────────────────────────────────────

function QueueEmpty({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-muted-foreground">
      <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
      {message}
    </div>
  );
}

function QueueError({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-destructive">
      <AlertCircle className="h-4 w-4 shrink-0" />
      {message} Check your connection and refresh.
    </div>
  );
}

function QueueSkeleton() {
  return (
    <section>
      <div className="mb-3 h-5 w-32 animate-pulse rounded-md bg-muted/70" />
      <GlassCard className="divide-y divide-border/50 p-0">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3.5">
            <div className="h-11 w-11 animate-pulse rounded-xl bg-muted/70" />
            <div className="flex-1 space-y-2">
              <div className="h-3.5 w-1/3 animate-pulse rounded bg-muted/70" />
              <div className="h-3 w-1/2 animate-pulse rounded bg-muted/50" />
            </div>
            <div className="h-9 w-24 animate-pulse rounded-xl bg-muted/70" />
          </div>
        ))}
      </GlassCard>
    </section>
  );
}
