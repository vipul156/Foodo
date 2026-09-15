// ============================================================
// Foodo — Admin Route Group Layout (Master Control)
// ============================================================

"use client";

import { useState, useRef, useEffect, type ReactNode } from "react";
import { useAuthStore } from "@/store/auth-store";
import { useLogout } from "@/features/auth/api";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut, User, LayoutDashboard, Store, Bike, Users, BarChart3, Settings } from "lucide-react";

export default function AdminLayout({
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

  const isActive = (href: string) => pathname === href;

  return (
    <div className="flex min-h-screen bg-muted/20">
      {/* Sidebar */}
      <aside className="hidden lg:flex w-64 flex-col border-r border-border bg-background">
        <div className="flex h-16 items-center gap-2 border-b border-border/50 px-6">
          <span className="text-lg font-bold tracking-tight">
            <span className="text-primary">Foodo</span>
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
              Admin
            </span>
          </span>
        </div>
        <nav className="flex-1 space-y-1 p-4">
          <AdminNavItem href="/admin" label="Dashboard" icon={LayoutDashboard} active={isActive("/admin")} />
          <AdminNavItem href="/admin/restaurants" label="Restaurants" icon={Store} active={isActive("/admin/restaurants")} />
          <AdminNavItem href="/admin/riders" label="Riders" icon={Bike} active={isActive("/admin/riders")} />
          <AdminNavItem href="/admin/users" label="Users" icon={Users} active={isActive("/admin/users")} />
          <AdminNavItem href="/admin/analytics" label="Analytics" icon={BarChart3} active={isActive("/admin/analytics")} />
          <AdminNavItem href="/admin/settings" label="Settings" icon={Settings} active={isActive("/admin/settings")} />
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

        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}

function AdminNavItem({
  href,
  label,
  icon: Icon,
  active,
}: {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
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
      <Icon className="h-4 w-4" />
      {label}
    </Link>
  );
}
