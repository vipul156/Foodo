// ============================================================
// Foodo — Admin Analytics Page (/admin/analytics)
// ============================================================

"use client";

import { GlassCard } from "@/components/shared/glass-card";
import { RoleGuard } from "@/components/shared/role-guard";
import { TrendingUp } from "lucide-react";

export default function AdminAnalyticsPage() {
  return (
    <RoleGuard allowedRoles={["admin"]}>
      <div className="space-y-6">
        <div>
          <h2 className="text-xl font-bold">Analytics</h2>
          <p className="text-sm text-muted-foreground">
            Platform performance and insights
          </p>
        </div>

        <GlassCard className="flex flex-col items-center justify-center py-16 text-center">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
            <TrendingUp className="h-8 w-8 text-primary" />
          </div>
          <h3 className="text-lg font-semibold">Analytics Dashboard</h3>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            View revenue trends, order metrics, user growth, and more.
            This feature is coming soon.
          </p>
        </GlassCard>
      </div>
    </RoleGuard>
  );
}
