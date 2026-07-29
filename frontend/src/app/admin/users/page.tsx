// ============================================================
// Foodo — Admin Users Page (/admin/users)
// ============================================================

"use client";

import { GlassCard } from "@/components/shared/glass-card";
import { RoleGuard } from "@/components/shared/role-guard";
import { Search } from "lucide-react";

export default function AdminUsersPage() {
  return (
    <RoleGuard allowedRoles={["admin"]}>
      <div className="space-y-6">
        <div>
          <h2 className="text-xl font-bold">Users</h2>
          <p className="text-sm text-muted-foreground">
            Manage all platform users
          </p>
        </div>

        <GlassCard className="flex flex-col items-center justify-center py-16 text-center">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
            <Search className="h-8 w-8 text-primary" />
          </div>
          <h3 className="text-lg font-semibold">User Management</h3>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            Search, filter, and manage all users across the platform. This
            feature is coming soon.
          </p>
        </GlassCard>
      </div>
    </RoleGuard>
  );
}
