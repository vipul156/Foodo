// ============================================================
// Foodo — Seller Route Group Layout (Dashboard)
// ============================================================

"use client";

import { useState, useRef, useEffect, type ReactNode } from "react";
import { useAuthStore } from "@/store/auth-store";
import { useLogout } from "@/features/auth/api";
import { useRealtimeOrderSync } from "@/hooks/use-realtime-order-sync";
import { useGetMyRestaurant } from "@/features/restaurants/api";
import { MobileSidebar, type SidebarItem } from "@/components/shared/mobile-sidebar";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LogOut,
  User,
  LayoutDashboard,
  BookOpen,
  ShoppingBag,
  BarChart3,
  Settings,
  Menu,
} from "lucide-react";

const NAV_ITEMS: SidebarItem[] = [
  { href: "/seller", label: "Dashboard", icon: LayoutDashboard },
  { href: "/seller/menu", label: "Menu", icon: BookOpen },
  { href: "/seller/orders", label: "Orders", icon: ShoppingBag },
  { href: "/seller/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/seller/settings", label: "Settings", icon: Settings },
];

export default function SellerLayout({
  children,
}: {
  children: ReactNode;
}) {
  const { user } = useAuthStore();
  // Every seller page refetches automatically on order lifecycle events
  useRealtimeOrderSync();
  const { data: restaurant } = useGetMyRestaurant();
  const pathname = usePathname();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const logout = useLogout();

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!dropdownOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [dropdownOpen]);

  const isActive = (href: string) => pathname === href;

  return (
    <div className="flex min-h-screen bg-muted/30">
      {/* Mobile slide-over sidebar */}
      <MobileSidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        title="Seller"
        items={NAV_ITEMS}
        currentPath={pathname}
        footer={
          <button
            onClick={() => logout()}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
          >
            <LogOut className="h-4 w-4" />
            Log out
          </button>
        }
      />

      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex w-64 flex-col border-r border-border bg-background">
        <div className="flex h-16 items-center gap-2 border-b border-border/50 px-6">
          <span className="text-lg font-bold tracking-tight">
            <span className="text-primary">Foodo</span>
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
              Seller
            </span>
          </span>
        </div>
        <nav className="flex-1 space-y-1 p-4">
          {NAV_ITEMS.map((item) => (
            <SidebarLink
              key={item.href}
              href={item.href}
              label={item.label}
              icon={item.icon}
              active={isActive(item.href)}
            />
          ))}
        </nav>

        {/* Sidebar Logout */}
        <div className="border-t border-border/50 p-4">
          <button
            onClick={() => logout()}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
          >
            <LogOut className="h-4 w-4" />
            Log out
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex flex-1 flex-col">
        {/* Top Bar */}
        <header className="sticky top-0 z-40 flex h-16 items-center gap-4 border-b border-border/50 bg-background px-4 sm:px-6">
          {/* Mobile menu toggle */}
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            className="rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors lg:hidden"
            aria-label="Open menu"
            aria-expanded={sidebarOpen}
          >
            <Menu className="h-5 w-5" />
          </button>

          <h1 className="text-lg font-semibold">Seller Dashboard</h1>
          <div className="ml-auto flex items-center gap-3">
            <RestaurantStatusBadge isOpen={restaurant?.isOpen} />
            <ProfileBadge
              name={user?.name || "S"}
              email={user?.email}
              dropdownOpen={dropdownOpen}
              setDropdownOpen={setDropdownOpen}
              dropdownRef={dropdownRef}
              logout={logout}
            />
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}

function SidebarLink({
  href,
  label,
  icon: Icon,
  active,
}: {
  href: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
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
      {Icon && <Icon className="h-4 w-4" />}
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

function ProfileBadge({
  name,
  email,
  dropdownOpen,
  setDropdownOpen,
  dropdownRef,
  logout,
}: {
  name: string;
  email?: string;
  dropdownOpen: boolean;
  setDropdownOpen: (open: boolean) => void;
  dropdownRef: React.RefObject<HTMLDivElement | null>;
  logout: () => void;
}) {
  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setDropdownOpen(!dropdownOpen)}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-sm font-medium text-primary hover:bg-primary/20 transition-colors"
        aria-label="Profile"
        aria-expanded={dropdownOpen}
      >
        {name?.charAt(0)?.toUpperCase() || <User className="h-4 w-4" />}
      </button>

      {/* Dropdown menu */}
      <div
        className={`absolute right-0 top-full mt-2 w-48 origin-top-right transition-all duration-150 rounded-xl border border-border/50 bg-background shadow-xl shadow-black/5 z-50 ${
          dropdownOpen
            ? "scale-100 opacity-100 visible"
            : "scale-95 opacity-0 invisible pointer-events-none"
        }`}
      >
        <div className="p-2">
          <p className="px-3 py-1.5 text-xs font-medium text-muted-foreground truncate">
            {name}
          </p>
          {email && (
            <p className="px-3 pb-1.5 text-xs text-muted-foreground truncate">
              {email}
            </p>
          )}
          <hr className="border-border/50 my-1" />
          <button
            onClick={() => {
              setDropdownOpen(false);
              logout();
            }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-destructive hover:bg-destructive/10 transition-colors"
          >
            <LogOut className="h-4 w-4" />
            Log out
          </button>
        </div>
      </div>
    </div>
  );
}
