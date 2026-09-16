// ============================================================
// Foodo — Admin Users Page (/admin/users) — Real Data
// ============================================================

"use client";

import { useMemo, useState } from "react";
import { GlassCard } from "@/components/shared/glass-card";
import { RoleGuard } from "@/components/shared/role-guard";
import { useGetAllUsers } from "@/features/admin/api";
import type { IPlatformUser } from "@/types";
import {
  Loader2,
  AlertCircle,
  Search,
  Users,
  Store,
  Bike,
  ShoppingCart,
  Shield,
  User as UserIcon,
} from "lucide-react";

const ROLE_FILTERS = [
  { value: undefined, label: "All" },
  { value: "customer", label: "Customers" },
  { value: "seller", label: "Sellers" },
  { value: "rider", label: "Riders" },
  { value: "admin", label: "Admins" },
] as const;

const ROLE_STYLES: Record<
  string,
  { icon: React.ComponentType<{ className?: string }>; className: string }
> = {
  customer: {
    icon: ShoppingCart,
    className: "bg-primary/10 text-primary",
  },
  seller: {
    icon: Store,
    className: "bg-secondary text-secondary-foreground",
  },
  rider: {
    icon: Bike,
    className: "bg-primary/10 text-primary",
  },
  admin: {
    icon: Shield,
    className: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-400",
  },
};

export default function AdminUsersPage() {
  const [role, setRole] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState("");

  const {
    data: users,
    isLoading,
    isError,
  } = useGetAllUsers(role);

  const filtered = useMemo(() => {
    if (!users) return [];
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        u.name?.toLowerCase().includes(q) ||
        u.email?.toLowerCase().includes(q),
    );
  }, [users, query]);

  return (
    <RoleGuard allowedRoles={["admin"]}>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h2 className="text-xl font-bold tracking-tight">Users</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {users
              ? `${users.length} account${users.length !== 1 ? "s" : ""}${role ? ` · ${role}s` : ""}`
              : "Everyone registered on the platform"}
          </p>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3">
          <div
            className="inline-flex rounded-xl border border-border bg-muted/40 p-0.5"
            role="group"
            aria-label="Filter by role"
          >
            {ROLE_FILTERS.map((f) => (
              <button
                key={f.label}
                type="button"
                onClick={() => setRole(f.value)}
                aria-pressed={role === f.value}
                className={`h-8 rounded-[10px] px-3.5 text-xs font-semibold transition-all ${
                  role === f.value
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="relative min-w-56 flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name or email…"
              aria-label="Search users"
              className="h-10 w-full rounded-xl border border-border bg-background pl-9 pr-4 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>

        {/* List */}
        <GlassCard className="divide-y divide-border/50 p-0">
          {isLoading ? (
            <>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-3.5">
                  <div className="h-10 w-10 animate-pulse rounded-full bg-muted/70" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3.5 w-1/4 animate-pulse rounded bg-muted/70" />
                    <div className="h-3 w-1/3 animate-pulse rounded bg-muted/50" />
                  </div>
                  <div className="h-5 w-20 animate-pulse rounded-full bg-muted/70" />
                </div>
              ))}
            </>
          ) : isError ? (
            <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              Couldn&apos;t load users. Check your connection and refresh.
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
              <Users className="mb-3 h-8 w-8 text-muted-foreground/50" />
              <p className="text-sm font-medium">
                {query ? "No matches" : "No users found"}
              </p>
              <p className="mt-1 max-w-xs text-sm text-muted-foreground">
                {query
                  ? `Nothing matches “${query}”. Try a different search.`
                  : role
                    ? `No ${role} accounts yet.`
                    : "Users appear here as they sign up."}
              </p>
            </div>
          ) : (
            filtered.map((user) => <UserRow key={user._id} user={user} />)
          )}
        </GlassCard>
      </div>
    </RoleGuard>
  );
}

// ─── User row ────────────────────────────────────────────────

function UserRow({ user }: { user: IPlatformUser }) {
  const role =
    ROLE_STYLES[user.role] ?? ROLE_STYLES.customer;
  const RoleIcon = role.icon;

  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      {/* Avatar — initial */}
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
        {user.name?.charAt(0)?.toUpperCase() || <UserIcon className="h-4 w-4" />}
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{user.name || "Unknown"}</p>
        <p className="truncate text-xs text-muted-foreground">
          {user.email}
          {user.createdAt &&
            ` · joined ${new Date(user.createdAt).toLocaleDateString("en-IN", {
              day: "numeric",
              month: "short",
              year: "numeric",
            })}`}
        </p>
      </div>

      {/* Role chip */}
      <span
        className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${role.className}`}
      >
        <RoleIcon className="h-3 w-3" />
        {user.role}
      </span>
    </div>
  );
}
