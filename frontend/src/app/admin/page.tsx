// ============================================================
// Foodo — Admin Dashboard Page (/admin)
// ============================================================

"use client";

import { GlassCard } from "@/components/shared/glass-card";
import { PremiumButton } from "@/components/shared/premium-button";
import { RoleGuard } from "@/components/shared/role-guard";
import {
  useGetPendingRestaurants,
  useGetPendingRiders,
  useVerifyRestaurant,
  useVerifyRider,
} from "@/features/admin/api";
import Link from "next/link";
import { Store, Bike, Loader2, Check, X, ArrowRight } from "lucide-react";

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
  const verifyRestaurant = useVerifyRestaurant();
  const verifyRider = useVerifyRider();

  const restaurantCount = pendingRestaurants?.length ?? 0;
  const riderCount = pendingRiders?.length ?? 0;
  const isLoading = loadingRestaurants || loadingRiders;

  return (
    <RoleGuard allowedRoles={["admin"]}>
      <div className="space-y-8">
        {/* Pending Verifications Grid */}
        <div className="grid gap-4 sm:grid-cols-2">
          <GlassCard>
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
                <Store className="h-6 w-6 text-primary" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">
                  Pending Restaurants
                </p>
                <p className="text-3xl font-bold">
                  {isLoading ? (
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  ) : (
                    restaurantCount
                  )}
                </p>
              </div>
            </div>
            <Link
              href="/admin/restaurants"
              className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              View all
              <ArrowRight className="h-3 w-3" />
            </Link>
          </GlassCard>

          <GlassCard>
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
                <Bike className="h-6 w-6 text-primary" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">
                  Pending Riders
                </p>
                <p className="text-3xl font-bold">
                  {isLoading ? (
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  ) : (
                    riderCount
                  )}
                </p>
              </div>
            </div>
            <Link
              href="/admin/riders"
              className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              View all
              <ArrowRight className="h-3 w-3" />
            </Link>
          </GlassCard>
        </div>

        {/* Pending Restaurants List */}
        <GlassCard>
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-lg font-semibold">
                Pending Restaurants
              </h2>
              <p className="text-sm text-muted-foreground">
                {restaurantCount} restaurant{restaurantCount !== 1 ? "s" : ""}{" "}
                awaiting verification
              </p>
            </div>
            <Link href="/admin/restaurants">
              <PremiumButton size="sm" variant="outline">
                View All
              </PremiumButton>
            </Link>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : pendingRestaurants && pendingRestaurants.length > 0 ? (
            <div className="space-y-3">
              {pendingRestaurants.slice(0, 5).map((r) => (
                <div
                  key={r._id}
                  className="flex items-center justify-between rounded-lg border border-border/50 p-4"
                >
                  <div className="flex items-center gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary text-sm font-bold">
                      <Store className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">{r.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {r.description?.slice(0, 50) || "No description"}
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <PremiumButton
                      size="sm"
                      variant="primary"
                      onClick={() => verifyRestaurant.mutate(r._id)}
                      disabled={verifyRestaurant.isPending && verifyRestaurant.variables === r._id}
                    >
                      {verifyRestaurant.isPending && verifyRestaurant.variables === r._id ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <Check className="h-3.5 w-3.5 mr-1" />
                      )}
                      Approve
                    </PremiumButton>
                    {/* TODO: Add reject handler when backend endpoint is available */}
                    <PremiumButton size="sm" variant="ghost">
                      <X className="h-3.5 w-3.5 mr-1" />
                      Reject
                    </PremiumButton>
                  </div>
                </div>
              ))}
            </div>
          ) : errorRestaurants ? (
            <div className="py-8 text-center text-sm text-destructive">
              Failed to load pending restaurants. Check connection.
            </div>
          ) : (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No pending restaurant verifications
            </div>
          )}
        </GlassCard>

        {/* Pending Riders List */}
        <GlassCard>
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-lg font-semibold">Pending Riders</h2>
              <p className="text-sm text-muted-foreground">
                {riderCount} rider{riderCount !== 1 ? "s" : ""} awaiting
                verification
              </p>
            </div>
            <Link href="/admin/riders">
              <PremiumButton size="sm" variant="outline">
                View All
              </PremiumButton>
            </Link>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : pendingRiders && pendingRiders.length > 0 ? (
            <div className="space-y-3">
              {pendingRiders.slice(0, 5).map((r) => (
                <div
                  key={r._id}
                  className="flex items-center justify-between rounded-lg border border-border/50 p-4"
                >
                  <div className="flex items-center gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary text-sm font-bold">
                      <Bike className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">
                        {r.phoneNumber || "Unknown Rider"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Pending verification
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <PremiumButton
                      size="sm"
                      variant="primary"
                      onClick={() => verifyRider.mutate(r._id)}
                      disabled={verifyRider.isPending && verifyRider.variables === r._id}
                    >
                      {verifyRider.isPending && verifyRider.variables === r._id ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <Check className="h-3.5 w-3.5 mr-1" />
                      )}
                      Approve
                    </PremiumButton>
                    {/* TODO: Add reject handler when backend endpoint is available */}
                    <PremiumButton size="sm" variant="ghost">
                      <X className="h-3.5 w-3.5 mr-1" />
                      Reject
                    </PremiumButton>
                  </div>
                </div>
              ))}
            </div>
          ) : errorRiders ? (
            <div className="py-8 text-center text-sm text-destructive">
              Failed to load pending riders. Check connection.
            </div>
          ) : (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No pending rider verifications
            </div>
          )}
        </GlassCard>
      </div>
    </RoleGuard>
  );
}
