// ============================================================
// Foodo — Rider Route Group Layout (Mobile-First)
// ============================================================

import type { ReactNode } from "react";

export default function RiderLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Top Bar */}
      <header className="sticky top-0 z-50 flex h-14 items-center justify-between border-b border-border/50 bg-background/80 backdrop-blur-xl px-4">
        <span className="text-lg font-bold tracking-tight">
          <span className="bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent">
            Foodo
          </span>
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            Rider
          </span>
        </span>
        <div className="flex items-center gap-2">
          <RiderAvailabilityBadge />
          <RiderProfile />
        </div>
      </header>

      {/* Main Content — Mobile optimized */}
      <main className="flex-1 px-4 pb-20 pt-4">{children}</main>

      {/* Bottom Navigation */}
      <nav className="fixed bottom-0 left-0 right-0 z-50 border-t border-border/50 bg-background/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-lg items-center justify-around py-2">
          <NavItem href="/rider" label="Home" icon="home" active />
          <NavItem href="/rider/earnings" label="Earnings" icon="wallet" />
          <NavItem href="/rider/history" label="History" icon="clock" />
          <NavItem href="/rider/profile" label="Profile" icon="user" />
        </div>
      </nav>
    </div>
  );
}

function NavItem({
  href,
  label,
  icon,
  active,
}: {
  href: string;
  label: string;
  icon: string;
  active?: boolean;
}) {
  return (
    <a
      href={href}
      className={`flex flex-col items-center gap-0.5 px-3 py-1 text-xs font-medium transition-colors ${
        active ? "text-primary" : "text-muted-foreground"
      }`}
    >
      <div className="rounded-full p-1.5">{icon === "home" && "🏠"}</div>
      <span>{label}</span>
    </a>
  );
}

function RiderAvailabilityBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
      Available
    </span>
  );
}

function RiderProfile() {
  return (
    <button className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-sm font-medium text-primary">
      R
    </button>
  );
}
