// ============================================================
// Foodo — Rider Dashboard Page (/rider)
// ============================================================

"use client";

import { GlassCard } from "@/components/shared/glass-card";
import { RoleGuard } from "@/components/shared/role-guard";
import { Navigation, Bell } from "lucide-react";

export default function RiderDashboardPage() {
  return (
    <RoleGuard allowedRoles={["rider"]}>
      <div className="space-y-6 pb-6">
        {/* Status Banner */}
        <div className="rounded-2xl bg-gradient-to-br from-emerald-500 to-emerald-600 p-6 text-white dark:from-emerald-600 dark:to-emerald-800">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-sm text-emerald-100">Status</p>
              <p className="text-xl font-bold">Available</p>
            </div>
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white/20">
              <Navigation className="h-6 w-6" />
            </div>
          </div>
          <p className="text-sm text-emerald-100">
            You are online and ready to accept deliveries
          </p>
        </div>

        {/* Earnings Today */}
        <GlassCard>
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold">Today&apos;s Earnings</h3>
            <span className="text-xs text-muted-foreground">
              Last 7 days
            </span>
          </div>
          <p className="text-3xl font-bold text-primary">₹1,240</p>
          <span className="text-xs text-emerald-600 dark:text-emerald-400">
            +8% from yesterday
          </span>
        </GlassCard>

        {/* Current Order */}
        <GlassCard>
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold">Active Delivery</h3>
            <Bell className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="rounded-xl bg-muted/50 p-4 text-center">
            <p className="text-3xl mb-2">🛵</p>
            <p className="text-sm font-medium">No active deliveries</p>
            <p className="text-xs text-muted-foreground mt-1">
              Waiting for new orders...
            </p>
          </div>
        </GlassCard>

        {/* Recent Deliveries */}
        <div>
          <h3 className="font-semibold mb-4">Recent Deliveries</h3>
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <DeliveryRow key={i} index={i} />
            ))}
          </div>
        </div>
      </div>
    </RoleGuard>
  );
}

function DeliveryRow({ index }: { index: number }) {
  return (
    <GlassCard className="p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
            🍕
          </div>
          <div>
            <p className="text-sm font-medium">Order #{2024000 + index}</p>
            <p className="text-xs text-muted-foreground">
              2.5 km &middot; 15 min ago
            </p>
          </div>
        </div>
        <span className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
          +₹{40 + index * 10}
        </span>
      </div>
    </GlassCard>
  );
}
