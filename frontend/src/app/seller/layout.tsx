// ============================================================
// Foodo — Seller Route Group Layout (Dashboard)
// ============================================================

import type { ReactNode } from "react";

export default function SellerLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen bg-muted/30">
      {/* Sidebar */}
      <aside className="hidden lg:flex w-64 flex-col border-r border-border bg-background">
        <div className="flex h-16 items-center gap-2 border-b border-border/50 px-6">
          <span className="text-lg font-bold tracking-tight">
            <span className="bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent">
              Foodo
            </span>
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
              Seller
            </span>
          </span>
        </div>
        <nav className="flex-1 space-y-1 p-4">
          <SidebarLink href="/seller" label="Dashboard" active />
          <SidebarLink href="/seller/menu" label="Menu" />
          <SidebarLink href="/seller/orders" label="Orders" />
          <SidebarLink href="/seller/analytics" label="Analytics" />
          <SidebarLink href="/seller/settings" label="Settings" />
        </nav>
      </aside>

      {/* Main Content */}
      <div className="flex flex-1 flex-col">
        {/* Top Bar */}
        <header className="sticky top-0 z-40 flex h-16 items-center gap-4 border-b border-border/50 bg-background px-6">
          <h1 className="text-lg font-semibold">Seller Dashboard</h1>
          <div className="ml-auto flex items-center gap-3">
            <RestaurantStatusBadge />
            <ProfileBadge />
          </div>
        </header>

        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}

function SidebarLink({
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

function RestaurantStatusBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
      Open
    </span>
  );
}

function ProfileBadge() {
  return (
    <button className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-sm font-medium text-primary">
      S
    </button>
  );
}
