// ============================================================
// Foodo — Admin Restaurants Page (/admin/restaurants)
// ============================================================

"use client";

import { GlassCard } from "@/components/shared/glass-card";
import { PremiumButton } from "@/components/shared/premium-button";
import { RoleGuard } from "@/components/shared/role-guard";
import { useGetPendingRestaurants, useVerifyRestaurant } from "@/features/admin/api";
import { Store, Loader2, Check, X } from "lucide-react";

export default function AdminRestaurantsPage() {
  const { data: restaurants, isLoading } = useGetPendingRestaurants();
  const verifyRestaurant = useVerifyRestaurant();

  return (
    <RoleGuard allowedRoles={["admin"]}>
      <div className="space-y-6">
        <div>
          <h2 className="text-xl font-bold">Restaurants</h2>
          <p className="text-sm text-muted-foreground">
            Pending restaurant verifications
          </p>
        </div>

        <GlassCard>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : restaurants && restaurants.length > 0 ? (
            <div className="divide-y divide-border/50">
              {restaurants.map((restaurant) => (
                <div
                  key={restaurant._id}
                  className="flex items-center justify-between p-4"
                >
                  <div className="flex items-center gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary text-sm font-bold">
                      <Store className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">{restaurant.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {restaurant.description?.slice(0, 60) || "No description"}
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <PremiumButton
                      size="sm"
                      variant="primary"
                      onClick={() => verifyRestaurant.mutate(restaurant._id)}
                      disabled={verifyRestaurant.isPending}
                    >
                      <Check className="h-3.5 w-3.5 mr-1" />
                      Approve
                    </PremiumButton>
                    <PremiumButton size="sm" variant="ghost">
                      <X className="h-3.5 w-3.5 mr-1" />
                      Reject
                    </PremiumButton>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="py-12 text-center text-sm text-muted-foreground">
              <Store className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50" />
              <p>No pending restaurant verifications</p>
            </div>
          )}
        </GlassCard>
      </div>
    </RoleGuard>
  );
}
