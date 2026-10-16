// ============================================================
// Foodo — Mobile Sidebar (Slide-over Drawer)
// Shared by the seller and admin dashboard layouts.
// ============================================================

"use client";

import { useEffect, type ReactNode } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SidebarItem {
  href: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
}

interface MobileSidebarProps {
  open: boolean;
  onClose: () => void;
  title: string;
  items: SidebarItem[];
  currentPath: string;
  /** Rendered below the nav — e.g. the logout button */
  footer?: ReactNode;
}

export function MobileSidebar({
  open,
  onClose,
  title,
  items,
  currentPath,
  footer,
}: MobileSidebarProps) {
  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  // Lock body scroll while open
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <div
      className={cn("lg:hidden", !open && "pointer-events-none")}
      aria-hidden={!open}
    >
      {/* Backdrop */}
      <div
        className={cn(
          "fixed inset-0 z-50 bg-black/40 backdrop-blur-sm transition-opacity duration-200",
          open ? "opacity-100" : "opacity-0",
        )}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`${title} navigation`}
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-border bg-background shadow-2xl transition-transform duration-300 ease-out",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        {/* Header */}
        <div className="flex h-16 shrink-0 items-center justify-between border-b border-border/50 px-5">
          <span className="text-lg font-bold tracking-tight">
            <span className="text-primary">Foodo</span>
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
              {title}
            </span>
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            aria-label="Close menu"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 space-y-1 overflow-y-auto p-4">
          {items.map((item) => {
            const Icon = item.icon;
            const active = currentPath === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onClose}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )}
                aria-current={active ? "page" : undefined}
              >
                {Icon && <Icon className="h-4 w-4 shrink-0" />}
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Footer (logout etc.) */}
        {footer && (
          <div className="shrink-0 border-t border-border/50 p-4">{footer}</div>
        )}
      </aside>
    </div>
  );
}
