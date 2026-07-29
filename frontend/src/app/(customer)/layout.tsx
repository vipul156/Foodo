// ============================================================
// Foodo — Customer Route Group Layout (Auth-Aware Navigation)
// ============================================================

"use client";

import { useState, useRef, useEffect, type ReactNode } from "react";
import Link from "next/link";
import { useAuthStore } from "@/store/auth-store";
import { useLogout } from "@/features/auth/api";
import { CartSheet } from "@/features/cart/components";
import { ShoppingCart, User, LogOut, LayoutDashboard } from "lucide-react";

export default function CustomerLayout({
  children,
}: {
  children: ReactNode;
}) {
  const { user, isAuthenticated } = useAuthStore();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [cartOpen, setCartOpen] = useState(false);
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

  // Determine dashboard link based on role
  const dashboardLink =
    user?.role === "seller"
      ? "/seller"
      : user?.role === "rider"
        ? "/rider"
        : user?.role === "admin"
          ? "/admin"
          : null;

  return (
    <div className="flex min-h-screen flex-col">
      {/* Top Navigation */}
      <header className="sticky top-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          {/* Logo */}
          <Link href="/" className="text-xl font-bold tracking-tight">
            <span className="bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent">
              Foodo
            </span>
          </Link>

          {/* Right side nav */}
          <nav className="flex items-center gap-3">
            {isAuthenticated ? (
              <>
                {/* Cart */}
                <button
                  onClick={() => setCartOpen(true)}
                  className="relative rounded-full p-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
                  aria-label="Open cart"
                >
                  <ShoppingCart className="h-5 w-5" />
                </button>

                {/* Dashboard link (sellers, riders, admins) */}
                {dashboardLink && (
                  <Link
                    href={dashboardLink}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/20 transition-colors"
                  >
                    <LayoutDashboard className="h-3.5 w-3.5" />
                    Dashboard
                  </Link>
                )}

                {/* Profile dropdown */}
                <div className="relative" ref={dropdownRef}>
                  <button
                    onClick={() => setDropdownOpen(!dropdownOpen)}
                    className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-sm font-medium text-primary hover:bg-primary/20 transition-colors"
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
                      {dashboardLink && (
                        <Link
                          href={dashboardLink}
                          onClick={() => setDropdownOpen(false)}
                          className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-foreground hover:bg-accent transition-colors"
                        >
                          <LayoutDashboard className="h-4 w-4" />
                          Dashboard
                        </Link>
                      )}
                      {/* TODO: Create /orders route */}
                      <Link
                        href="/orders"
                        onClick={() => setDropdownOpen(false)}
                        className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-foreground hover:bg-accent transition-colors"
                      >
                        <ShoppingCart className="h-4 w-4" />
                        My Orders
                      </Link>
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
              </>
            ) : (
              <>
                {/* Guest navigation */}
                <Link
                  href="/register"
                  className="inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-medium text-foreground hover:bg-accent transition-colors"
                >
                  Sign Up
                </Link>
                <Link
                  href="/login"
                  className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors shadow-sm"
                >
                  Log In
                </Link>
              </>
            )}
          </nav>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1">{children}</main>

      {/* Footer */}
      <footer className="border-t border-border/50 py-8 text-center text-sm text-muted-foreground">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <Link href="/" className="text-lg font-bold tracking-tight">
            <span className="bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent">
              Foodo
            </span>
          </Link>
          <p className="mt-2">
            &copy; {new Date().getFullYear()} Foodo. All rights reserved.
          </p>
          <div className="mt-3 flex items-center justify-center gap-4 text-xs">
            <Link href="/" className="hover:text-primary transition-colors">
              Home
            </Link>
            <Link href="/restaurants" className="hover:text-primary transition-colors">
              Restaurants
            </Link>
            <Link href="/login" className="hover:text-primary transition-colors">
              Log In
            </Link>
            <Link href="/register" className="hover:text-primary transition-colors">
              Sign Up
            </Link>
          </div>
        </div>
      </footer>

      {/* Cart Sheet */}
      <CartSheet open={cartOpen} onClose={() => setCartOpen(false)} />
    </div>
  );
}
