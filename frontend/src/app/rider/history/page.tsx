// ============================================================
// Foodo — Rider History Page (/rider/history)
// ============================================================

"use client";

import { RoleGuard } from "@/components/shared/role-guard";
import { GlassCard } from "@/components/shared/glass-card";
import { Clock } from "lucide-react";

export default function RiderHistoryPage() {
  return (
    <RoleGuard allowedRoles={["rider"]}>
      <div className="space-y-6 pb-6">
        <div>
          <h2 className="text-xl font-bold">Delivery History</h2>
          <p className="text-sm text-muted-foreground">
            View your past deliveries
          </p>
        </div>

        <GlassCard className="flex flex-col items-center justify-center py-12 text-center">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
            <Clock className="h-8 w-8 text-primary" />
          </div>
          <h3 className="text-lg font-semibold">No Deliveries Yet</h3>
          <p className="mt-1 max-w-xs text-sm text-muted-foreground">
            Your completed deliveries will appear here once you start accepting
            orders.
          </p>
        </GlassCard>
      </div>
    </RoleGuard>
  );
}
