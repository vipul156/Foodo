// ============================================================
// Foodo — Admin Riders Page (/admin/riders)
// Pending verification queue + full rider roster
// ============================================================

"use client";

import { useMemo, useState } from "react";
import { GlassCard } from "@/components/shared/glass-card";
import { PremiumButton } from "@/components/shared/premium-button";
import { RoleGuard } from "@/components/shared/role-guard";
import {
  useGetPendingRiders,
  useGetAllRiders,
  useVerifyRider,
} from "@/features/admin/api";
import type { IAllRider, IPendingRider } from "@/types";
import {
  Bike,
  Loader2,
  Check,
  Phone,
  Search,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";

type Tab = "pending" | "all";

export default function AdminRidersPage() {
  const [tab, setTab] = useState<Tab>("pending");
  const [query, setQuery] = useState("");

  const {
    data: pending,
    isLoading: loadingPending,
    isError: errorPending,
  } = useGetPendingRiders();
  const {
    data: all,
    isLoading: loadingAll,
    isError: errorAll,
  } = useGetAllRiders();
  const verifyRider = useVerifyRider();

  const pendingCount = pending?.length ?? 0;
  const allCount = all?.length ?? 0;

  const filteredAll = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !all) return all;
    return all.filter((r) => r.phoneNumber?.toLowerCase().includes(q));
  }, [all, query]);

  return (
    <RoleGuard allowedRoles={["admin"]}>
      <div className="space-y-6">
        {/* Header + tabs */}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold tracking-tight">Riders</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {tab === "pending"
                ? "New riders waiting for verification"
                : `${allCount} rider${allCount !== 1 ? "s" : ""} on the platform`}
            </p>
          </div>
          <div
            className="inline-flex rounded-xl border border-border bg-muted/40 p-0.5"
            role="group"
            aria-label="Rider view"
          >
            {(
              [
                ["pending", "Pending"],
                ["all", "All riders"],
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
                Couldn&apos;t load pending riders. Check your connection and
                refresh.
              </div>
            ) : pendingCount === 0 ? (
              <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
                <CheckCircle2 className="mb-3 h-8 w-8 text-emerald-600 dark:text-emerald-400" />
                <p className="text-sm font-medium">Queue is clear</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  No riders waiting for verification right now.
                </p>
              </div>
            ) : (
              pending!.map((rider) => (
                <PendingRow
                  key={rider._id}
                  rider={rider}
                  onApprove={() => verifyRider.mutate(rider._id)}
                  isApproving={
                    verifyRider.isPending &&
                    verifyRider.variables === rider._id
                  }
                />
              ))
            )}
          </GlassCard>
        ) : (
          /* ── All riders roster ───────────────────────────── */
          <>
            <div className="relative max-w-sm">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by phone number…"
                aria-label="Search riders"
                className="h-10 w-full rounded-xl border border-border bg-background pl-9 pr-4 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            <GlassCard className="divide-y divide-border/50 p-0">
              {loadingAll ? (
                <QueueSkeleton />
              ) : errorAll ? (
                <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  Couldn&apos;t load riders. Check your connection and refresh.
                </div>
              ) : !filteredAll || filteredAll.length === 0 ? (
                <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
                  <Bike className="mb-3 h-8 w-8 text-muted-foreground/50" />
                  <p className="text-sm font-medium">
                    {query ? "No matches" : "No riders yet"}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {query
                      ? `Nothing matches “${query}”. Try a different search.`
                      : "Riders appear here once they register their profiles."}
                  </p>
                </div>
              ) : (
                filteredAll.map((rider) => <RosterRow key={rider._id} rider={rider} />)
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

// ─── Roster row — availability at a glance ───────────────────

function RosterRow({ rider }: { rider: IAllRider }) {
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
        {rider.lastActive && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            Last active {new Date(rider.lastActive).toLocaleDateString("en-IN", {
              day: "numeric",
              month: "short",
            })}
          </p>
        )}
      </div>

      {/* Status chips */}
      <div className="flex shrink-0 items-center gap-2">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
            rider.isAvailable
              ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
              : "bg-muted text-muted-foreground"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              rider.isAvailable
                ? "bg-emerald-500"
                : "bg-muted-foreground/50"
            }`}
          />
          {rider.isAvailable ? "Online" : "Offline"}
        </span>
        {!rider.isVerified && (
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
