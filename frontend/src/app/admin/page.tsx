// ============================================================
// Foodo — Admin Dashboard Page (/admin)
// ============================================================

"use client";

import { GlassCard } from "@/components/shared/glass-card";
import { PremiumButton } from "@/components/shared/premium-button";
import { RoleGuard } from "@/components/shared/role-guard";

export default function AdminDashboardPage() {
  return (
    <RoleGuard allowedRoles={["admin"]}>
      <div className="space-y-8">
        {/* Stats Grid */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Total Users" value="12,345" change="+12%" />
          <StatCard label="Restaurants" value="567" change="+8%" />
          <StatCard label="Active Riders" value="234" change="+15%" />
          <StatCard label="Total Orders" value="45,678" change="+23%" />
        </div>

        {/* Pending Verifications */}
        <GlassCard>
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-lg font-semibold">
                Pending Verifications
              </h2>
              <p className="text-sm text-muted-foreground">
                Approve or reject new restaurants and riders
              </p>
            </div>
            <PremiumButton size="sm" variant="outline">
              View All
            </PremiumButton>
          </div>
          <div className="space-y-4">
            <PendingItem
              type="Restaurant"
              name="Pizza Palace"
              date="2 hours ago"
            />
            <PendingItem
              type="Restaurant"
              name="Burger Barn"
              date="5 hours ago"
            />
            <PendingItem type="Rider" name="John Doe" date="1 day ago" />
          </div>
        </GlassCard>

        {/* Recent Activity */}
        <GlassCard>
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-lg font-semibold">Recent Orders</h2>
              <p className="text-sm text-muted-foreground">
                Latest orders across the platform
              </p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50">
                  <th className="text-left py-3 px-2 font-medium">Order</th>
                  <th className="text-left py-3 px-2 font-medium">
                    Restaurant
                  </th>
                  <th className="text-left py-3 px-2 font-medium">Status</th>
                  <th className="text-right py-3 px-2 font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {[1, 2, 3, 4, 5].map((i) => (
                  <tr
                    key={i}
                    className="border-b border-border/30 hover:bg-muted/50 transition-colors"
                  >
                    <td className="py-3 px-2">#ORD-{2024000 + i}</td>
                    <td className="py-3 px-2">Restaurant {i}</td>
                    <td className="py-3 px-2">
                      <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">
                        Delivered
                      </span>
                    </td>
                    <td className="py-3 px-2 text-right">
                      ₹{Math.floor(Math.random() * 500) + 100}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </GlassCard>
      </div>
    </RoleGuard>
  );
}

function StatCard({
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
      <p className="mt-1 text-3xl font-bold">{value}</p>
      <span className="mt-1 inline-block text-xs font-medium text-emerald-600 dark:text-emerald-400">
        {change}
      </span>
    </GlassCard>
  );
}

function PendingItem({
  type,
  name,
  date,
}: {
  type: string;
  name: string;
  date: string;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border/50 p-4">
      <div className="flex items-center gap-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary text-sm font-bold">
          {type === "Restaurant" ? "R" : "D"}
        </div>
        <div>
          <p className="text-sm font-medium">{name}</p>
          <p className="text-xs text-muted-foreground">
            {type} &middot; {date}
          </p>
        </div>
      </div>
      <div className="flex gap-2">
        <PremiumButton size="sm" variant="primary">
          Approve
        </PremiumButton>
        <PremiumButton size="sm" variant="ghost">
          Reject
        </PremiumButton>
      </div>
    </div>
  );
}
