// ============================================================
// Foodo — Admin Riders Page (/admin/riders)
// ============================================================

"use client";

import { GlassCard } from "@/components/shared/glass-card";
import { PremiumButton } from "@/components/shared/premium-button";
import { RoleGuard } from "@/components/shared/role-guard";
import { useGetPendingRiders, useVerifyRider } from "@/features/admin/api";
import { Bike, Loader2, Check, X, Phone } from "lucide-react";

export default function AdminRidersPage() {
  const { data: riders, isLoading } = useGetPendingRiders();
  const verifyRider = useVerifyRider();

  return (
    <RoleGuard allowedRoles={["admin"]}>
      <div className="space-y-6">
        <div>
          <h2 className="text-xl font-bold">Riders</h2>
          <p className="text-sm text-muted-foreground">
            Pending rider verifications
          </p>
        </div>

        <GlassCard>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : riders && riders.length > 0 ? (
            <div className="divide-y divide-border/50">
              {riders.map((rider) => (
                <div
                  key={rider._id}
                  className="flex items-center justify-between p-4"
                >
                  <div className="flex items-center gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary text-sm font-bold">
                      <Bike className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">
                        {rider.phoneNumber || "Unknown Rider"}
                      </p>
                      <p className="text-xs text-muted-foreground flex items-center gap-1">
                        <Phone className="h-3 w-3" />
                        {rider.phoneNumber}
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <PremiumButton
                      size="sm"
                      variant="primary"
                      onClick={() => verifyRider.mutate(rider._id)}
                      disabled={verifyRider.isPending}
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
              <Bike className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50" />
              <p>No pending rider verifications</p>
            </div>
          )}
        </GlassCard>
      </div>
    </RoleGuard>
  );
}
