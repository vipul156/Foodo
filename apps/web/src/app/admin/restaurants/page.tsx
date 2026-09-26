// ============================================================
// Foodo — Admin Restaurants Page (/admin/restaurants)
// Pending verification queue + full restaurant roster
// ============================================================

"use client";

import { useMemo, useState } from "react";
import { GlassCard } from "@/components/shared/glass-card";
import { PremiumButton } from "@/components/shared/premium-button";
import { RoleGuard } from "@/components/shared/role-guard";
import {
  useGetPendingRestaurants,
  useGetAllRestaurants,
  useVerifyRestaurant,
} from "@/features/admin/api";
import type { IAllRestaurant, IPendingRestaurant } from "@/types";
import {
  Store,
  Loader2,
  Check,
  Phone,
  Search,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";

type Tab = "pending" | "all";

export default function AdminRestaurantsPage() {
  const [tab, setTab] = useState<Tab>("pending");
  const [query, setQuery] = useState("");

  const {
    data: pending,
    isLoading: loadingPending,
    isError: errorPending,
  } = useGetPendingRestaurants();
  const {
    data: all,
    isLoading: loadingAll,
    isError: errorAll,
  } = useGetAllRestaurants();
  const verifyRestaurant = useVerifyRestaurant();

  const pendingCount = pending?.length ?? 0;
  const allCount = all?.length ?? 0;

  // Client-side search over name + description
  const filteredAll = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !all) return all;
    return all.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.description?.toLowerCase().includes(q),
    );
  }, [all, query]);

  return (
    <RoleGuard allowedRoles={["admin"]}>
      <div className="space-y-6">
        {/* Header + tabs */}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold tracking-tight">Restaurants</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {tab === "pending"
                ? "New signups waiting for verification"
                : `${allCount} restaurant${allCount !== 1 ? "s" : ""} on the platform`}
            </p>
          </div>
          <div
            className="inline-flex rounded-xl border border-border bg-muted/40 p-0.5"
            role="group"
            aria-label="Restaurant view"
          >
            {(
              [
                ["pending", "Pending"],
                ["all", "All restaurants"],
              ] as [Tab, string][]
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setTab(value)}
                aria-pressed={tab === value}
                className={`inline-flex h-8 items-center gap-1.5 rounded-[10px] px-4 text-xs font-semibold transition-all ${
                  tab === value
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {label}
                {value === "pending" && pendingCount > 0 && (
                  <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                    {pendingCount}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* ── Pending queue ─────────────────────────────────── */}
        {tab === "pending" ? (
          <GlassCard className="divide-y divide-border/50 p-0">
            {loadingPending ? (
              <QueueSkeleton />
            ) : errorPending ? (
              <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0" />
                Couldn&apos;t load pending restaurants. Check your connection
                and refresh.
              </div>
            ) : pendingCount === 0 ? (
              <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
                <CheckCircle2 className="mb-3 h-8 w-8 text-emerald-600 dark:text-emerald-400" />
                <p className="text-sm font-medium">Queue is clear</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  No restaurants waiting for verification right now.
                </p>
              </div>
            ) : (
              pending!.map((restaurant) => (
                <PendingRow
                  key={restaurant._id}
                  restaurant={restaurant}
                  onApprove={() => verifyRestaurant.mutate(restaurant._id)}
                  isApproving={
                    verifyRestaurant.isPending &&
                    verifyRestaurant.variables === restaurant._id
                  }
                />
              ))
            )}
          </GlassCard>
        ) : (
          /* ── All restaurants roster ──────────────────────── */
          <>
            {/* Search */}
            <div className="relative max-w-sm">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name or description…"
                aria-label="Search restaurants"
                className="h-10 w-full rounded-xl border border-border bg-background pl-9 pr-4 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            <GlassCard className="divide-y divide-border/50 p-0">
              {loadingAll ? (
                <QueueSkeleton />
              ) : errorAll ? (
                <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  Couldn&apos;t load restaurants. Check your connection and
                  refresh.
                </div>
              ) : !filteredAll || filteredAll.length === 0 ? (
                <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
                  <Store className="mb-3 h-8 w-8 text-muted-foreground/50" />
                  <p className="text-sm font-medium">
                    {query ? "No matches" : "No restaurants yet"}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {query
                      ? `Nothing matches “${query}”. Try a different search.`
                      : "Restaurants appear here once owners register them."}
                  </p>
                </div>
              ) : (
                filteredAll.map((restaurant) => (
                  <RosterRow key={restaurant._id} restaurant={restaurant} />
                ))
              )}
            </GlassCard>
          </>
        )}
      </div>
    </RoleGuard>
  );
}

// ─── Pending row — approve action ────────────────────────────

function PendingRow({
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

// ─── Roster row — status at a glance ─────────────────────────

function RosterRow({ restaurant }: { restaurant: IAllRestaurant }) {
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

      {/* Status chips */}
      <div className="flex shrink-0 items-center gap-2">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
            restaurant.isOpen
              ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
              : "bg-muted text-muted-foreground"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              restaurant.isOpen
                ? "bg-emerald-500"
                : "bg-muted-foreground/50"
            }`}
          />
          {restaurant.isOpen ? "Active" : "Closed"}
        </span>
        {!restaurant.isVerified && (
          <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-400">
            Unverified
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Skeleton ────────────────────────────────────────────────

function QueueSkeleton() {
  return (
    <>
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
    </>
  );
}
