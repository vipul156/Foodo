// ============================================================
// Foodo — Rider Route Group Layout (Mobile-First)
// ============================================================

"use client";

import { useState, useRef, useEffect, type ReactNode } from "react";
import { useAuthStore } from "@/store/auth-store";
import { useLogout } from "@/features/auth/api";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut, User } from "lucide-react";

export default function RiderLayout({
  children,
}: {
  children: ReactNode;
}) {
  const { user } = useAuthStore();
  const pathname = usePathname();
  const [dropdownOpen, setDropdownOpen] = useState(false);
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

          {/* Profile dropdown */}
          <div className="relative" ref={dropdownRef}>
            <button
              onClick={() => setDropdownOpen(!dropdownOpen)}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-sm font-medium text-primary hover:bg-primary/20 transition-colors"
              aria-label="Profile"
              aria-expanded={dropdownOpen}
            >
              {user?.name?.charAt(0)?.toUpperCase() || <User className="h-4 w-4" />}
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
                  {user?.name}
                </p>
                <p className="px-3 pb-1.5 text-xs text-muted-foreground truncate">
                  {user?.email}
                </p>
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
        </div>
      </header>

      {/* Main Content — Mobile optimized */}
      <main className="flex-1 px-4 pb-20 pt-4">{children}</main>

      {/* Bottom Navigation */}
      <nav className="fixed bottom-0 left-0 right-0 z-50 border-t border-border/50 bg-background/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-lg items-center justify-around py-2">
          <NavItem href="/rider" label="Home" icon="home" active={pathname === "/rider"} />
          <NavItem href="/rider/earnings" label="Earnings" icon="wallet" active={pathname === "/rider/earnings"} />
          <NavItem href="/rider/history" label="History" icon="clock" active={pathname === "/rider/history"} />
          <NavItem href="/rider/profile" label="Profile" icon="user" active={pathname === "/rider/profile"} />
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
  const icons: Record<string, string> = {
    home: "🏠",
    wallet: "💰",
    clock: "🕐",
    user: "👤",
  };

  return (
    <Link
      href={href}
      className={`flex flex-col items-center gap-0.5 px-3 py-1 text-xs font-medium transition-colors ${
        active ? "text-primary" : "text-muted-foreground"
      }`}
    >
      <div className="rounded-full p-1.5">{icons[icon] || "•"}</div>
      <span>{label}</span>
    </Link>
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
