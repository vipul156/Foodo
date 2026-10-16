// ============================================================
// Foodo — Admin Settings Page (/admin/settings)
// ============================================================

"use client";

import { useAuthStore } from "@/store/auth-store";
import { GlassCard } from "@/components/shared/glass-card";
import { RoleGuard } from "@/components/shared/role-guard";
import { User, Shield, Mail } from "lucide-react";

export default function AdminSettingsPage() {
  const { user } = useAuthStore();

  return (
    <RoleGuard allowedRoles={["admin"]}>
      <div className="space-y-6">
        <div>
          <h2 className="text-xl font-bold">Settings</h2>
          <p className="text-sm text-muted-foreground">
            Admin account settings
          </p>
        </div>

        <GlassCard>
          <div className="flex flex-col items-center py-6 text-center">
            <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-primary/10 text-3xl font-bold text-primary">
              {user?.name?.charAt(0)?.toUpperCase() || (
                <User className="h-10 w-10" />
              )}
            </div>
            <h3 className="text-xl font-semibold">
              {user?.name || "Admin"}
            </h3>
            <p className="text-sm text-muted-foreground">{user?.email}</p>
          </div>

          <hr className="border-border/50" />

          <div className="space-y-3 p-4">
            <div className="flex items-center gap-3 rounded-lg bg-muted/50 p-3">
              <Mail className="h-4 w-4 text-muted-foreground" />
              <div className="text-sm">
                <p className="font-medium">Email</p>
                <p className="text-muted-foreground">{user?.email}</p>
              </div>
            </div>
            <div className="flex items-center gap-3 rounded-lg bg-muted/50 p-3">
              <Shield className="h-4 w-4 text-muted-foreground" />
              <div className="text-sm">
                <p className="font-medium">Role</p>
                <p className="text-muted-foreground capitalize">
                  {user?.role || "Admin"}
                </p>
              </div>
            </div>
          </div>
        </GlassCard>
      </div>
    </RoleGuard>
  );
}
