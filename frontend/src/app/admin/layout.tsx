// ============================================================
// Foodo — Admin Route Group Layout (Master Control)
// ============================================================

import type { ReactNode } from "react";

export default function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen bg-muted/20">
      {/* Sidebar */}
      <aside className="hidden lg:flex w-64 flex-col border-r border-border bg-background">
        <div className="flex h-16 items-center gap-2 border-b border-border/50 px-6">
          <span className="text-lg font-bold tracking-tight">
            <span className="bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent">
              Foodo
            </span>
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
              Admin
            </span>
          </span>
        </div>
        <nav className="flex-1 space-y-1 p-4">
          <AdminNavItem href="/admin" label="Dashboard" active />
          <AdminNavItem href="/admin/restaurants" label="Restaurants" />
          <AdminNavItem href="/admin/riders" label="Riders" />
          <AdminNavItem href="/admin/users" label="Users" />
          <AdminNavItem href="/admin/analytics" label="Analytics" />
          <AdminNavItem href="/admin/settings" label="Settings" />
        </nav>
        <div className="border-t border-border/50 p-4">
          <AdminProfileBadge />
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex flex-1 flex-col">
        <header className="sticky top-0 z-40 flex h-16 items-center gap-4 border-b border-border/50 bg-background px-6">
          <h1 className="text-lg font-semibold">
            Admin Control Panel
          </h1>
          <div className="ml-auto flex items-center gap-3">
            <span className="text-sm text-muted-foreground">
              {new Date().toLocaleDateString("en-US", {
                weekday: "long",
                month: "long",
                day: "numeric",
              })}
            </span>
          </div>
        </header>

        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}

function AdminNavItem({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active?: boolean;
}) {
  return (
    <a
      href={href}
      className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
        active
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      }`}
    >
      {label}
    </a>
  );
}

function AdminProfileBadge() {
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
        A
      </div>
      <div className="flex flex-col">
        <span className="text-sm font-medium">Admin</span>
        <span className="text-xs text-muted-foreground">Super Admin</span>
      </div>
    </div>
  );
}
