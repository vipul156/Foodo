// ============================================================
// Foodo — Seller Dashboard Page (/seller)
// ============================================================

"use client";

import { GlassCard } from "@/components/shared/glass-card";
import { PremiumButton } from "@/components/shared/premium-button";
import { RoleGuard } from "@/components/shared/role-guard";
import { Plus } from "lucide-react";

export default function SellerDashboardPage() {
  return (
    <RoleGuard allowedRoles={["seller"]}>
      <div className="space-y-8">
        {/* Quick Stats */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <QuickStat label="Today's Orders" value="24" change="+6" />
          <QuickStat label="Revenue" value="₹4,560" change="+12%" />
          <QuickStat label="Active Items" value="32" change="-" />
          <QuickStat label="Rating" value="4.5" change="★" />
        </div>

        {/* Recent Orders */}
        <GlassCard>
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-lg font-semibold">Recent Orders</h2>
              <p className="text-sm text-muted-foreground">
                Manage incoming orders
              </p>
            </div>
            <PremiumButton size="sm" variant="outline">
              View All
            </PremiumButton>
          </div>
          <div className="space-y-3">
            {["Placed", "Preparing", "Ready", "Delivered"].map((status, i) => (
              <OrderRow key={i} index={i + 1} status={status as any} />
            ))}
          </div>
        </GlassCard>

        {/* Quick Actions */}
        <div className="grid gap-4 sm:grid-cols-2">
          <GlassCard hover className="cursor-pointer">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
                <Plus className="h-6 w-6 text-primary" />
              </div>
              <div>
                <h3 className="font-semibold">Add Menu Item</h3>
                <p className="text-sm text-muted-foreground">
                  Add new dishes to your menu
                </p>
              </div>
            </div>
          </GlassCard>
          <GlassCard hover className="cursor-pointer">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-50 dark:bg-emerald-950">
                <span className="text-2xl">📊</span>
              </div>
              <div>
                <h3 className="font-semibold">View Analytics</h3>
                <p className="text-sm text-muted-foreground">
                  Check your performance
                </p>
              </div>
            </div>
          </GlassCard>
        </div>
      </div>
    </RoleGuard>
  );
}

function QuickStat({
  label,
  value,
  change,
}: {
  label: string;
  value: string;
  change: string;
}) {
  return (
    <GlassCard>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
      <span className="mt-1 inline-block text-xs font-medium text-emerald-600 dark:text-emerald-400">
        {change}
      </span>
    </GlassCard>
  );
}

function OrderRow({
  index,
  status,
}: {
  index: number;
  status: "Placed" | "Preparing" | "Ready" | "Delivered";
}) {
  const statusColors: Record<string, string> = {
    Placed: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-400",
    Preparing:
      "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-400",
    Ready: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
    Delivered:
      "bg-zinc-50 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400",
  };

  return (
    <div className="flex items-center justify-between rounded-lg border border-border/50 p-4">
      <div className="flex items-center gap-4">
        <span className="text-sm font-medium">#ORD-{2024000 + index}</span>
        <span className="text-xs text-muted-foreground">
          Table {index + 1}
        </span>
      </div>
      <span
        className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
          statusColors[status]
        }`}
      >
        {status}
      </span>
      <span className="text-sm font-medium">
        ₹{Math.floor(Math.random() * 500) + 200}
      </span>
    </div>
  );
}
