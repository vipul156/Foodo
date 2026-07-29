// ============================================================
// Foodo — Rider Earnings Page (/rider/earnings)
// ============================================================

"use client";

import { RoleGuard } from "@/components/shared/role-guard";
import { GlassCard } from "@/components/shared/glass-card";
import { Wallet } from "lucide-react";

export default function RiderEarningsPage() {
  return (
    <RoleGuard allowedRoles={["rider"]}>
      <div className="space-y-6 pb-6">
        <div>
          <h2 className="text-xl font-bold">Earnings</h2>
          <p className="text-sm text-muted-foreground">
            Track your delivery earnings
          </p>
        </div>

        <GlassCard className="flex flex-col items-center justify-center py-12 text-center">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
            <Wallet className="h-8 w-8 text-primary" />
          </div>
          <h3 className="text-lg font-semibold">Coming Soon</h3>
          <p className="mt-1 max-w-xs text-sm text-muted-foreground">
            Earnings tracking will be available here once you complete your
            first delivery.
          </p>
        </GlassCard>
      </div>
    </RoleGuard>
  );
}
