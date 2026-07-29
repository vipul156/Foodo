// ============================================================
// Foodo — Seller Route Group Layout (Dashboard)
// ============================================================

"use client";

import type { ReactNode } from "react";
import { useAuthStore } from "@/store/auth-store";
import { useGetMyRestaurant } from "@/features/restaurants/api";
import Link from "next/link";
import { usePathname } from "next/navigation";

export default function SellerLayout({
  children,
}: {
  children: ReactNode;
}) {
  const { user } = useAuthStore();
  const { data: restaurant } = useGetMyRestaurant();
  const pathname = usePathname();

  const isActive = (href: string) => pathname === href;

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
          <SidebarLink href="/seller" label="Dashboard" active={isActive("/seller")} />
          <SidebarLink href="/seller/menu" label="Menu" active={isActive("/seller/menu")} />
          <SidebarLink href="/seller/orders" label="Orders" active={isActive("/seller/orders")} />
          <SidebarLink href="/seller/analytics" label="Analytics" active={isActive("/seller/analytics")} />
          <SidebarLink href="/seller/settings" label="Settings" active={isActive("/seller/settings")} />
        </nav>
      </aside>

      {/* Main Content */}
      <div className="flex flex-1 flex-col">
        {/* Top Bar */}
        <header className="sticky top-0 z-40 flex h-16 items-center gap-4 border-b border-border/50 bg-background px-6">
          <h1 className="text-lg font-semibold">Seller Dashboard</h1>
          <div className="ml-auto flex items-center gap-3">
            <RestaurantStatusBadge isOpen={restaurant?.isOpen} />
            <ProfileBadge name={user?.name || "S"} />
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
    <Link
      href={href}
      className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
        active
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      }`}
    >
      {label}
    </Link>
  );
}

function RestaurantStatusBadge({ isOpen }: { isOpen?: boolean }) {
  if (isOpen === undefined) return null;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
        isOpen
          ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
          : "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-400"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          isOpen ? "bg-emerald-500" : "bg-red-500"
        }`}
      />
      {isOpen ? "Open" : "Closed"}
    </span>
  );
}

function ProfileBadge({ name }: { name: string }) {
  return (
    <button className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-sm font-medium text-primary">
      {name.charAt(0).toUpperCase()}
    </button>
  );
}
