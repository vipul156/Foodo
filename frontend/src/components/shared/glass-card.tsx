// ============================================================
// Foodo — Glass Card (Premium Glassmorphism Component)
// ============================================================

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface GlassCardProps {
  children: ReactNode;
  className?: string;
  variant?: "default" | "elevated" | "bordered";
  hover?: boolean;
  as?: "div" | "section" | "article";
}

export function GlassCard({
  children,
  className,
  variant = "default",
  hover = false,
  as: Component = "div",
}: GlassCardProps) {
  return (
    <Component
      className={cn(
        // Base glass effect
        "rounded-2xl border backdrop-blur-xl transition-all duration-300",
        // Variants
        variant === "default" &&
          "border-white/20 bg-white/70 shadow-lg shadow-black/5 dark:border-white/10 dark:bg-black/40 dark:shadow-black/20",
        variant === "elevated" &&
          "border-white/30 bg-white/80 shadow-xl shadow-black/8 dark:border-white/15 dark:bg-black/50 dark:shadow-black/30",
        variant === "bordered" &&
          "border-primary/20 bg-white/60 shadow-md dark:border-primary/10 dark:bg-black/30",
        // Hover effect
        hover &&
          "hover:border-white/40 hover:shadow-2xl hover:shadow-primary/5 hover:-translate-y-0.5 dark:hover:border-white/20",
        className,
      )}
    >
      {children}
    </Component>
  );
}

// ─── Glass Card Sub-components ───────────────────────────────

interface GlassCardSectionProps {
  children: ReactNode;
  className?: string;
}

export function GlassCardHeader({
  children,
  className,
}: GlassCardSectionProps) {
  return (
    <div className={cn("px-6 pt-6 pb-4 border-b border-white/10", className)}>
      {children}
    </div>
  );
}

export function GlassCardContent({
  children,
  className,
}: GlassCardSectionProps) {
  return <div className={cn("px-6 py-4", className)}>{children}</div>;
}

export function GlassCardFooter({
  children,
  className,
}: GlassCardSectionProps) {
  return (
    <div
      className={cn(
        "px-6 pt-4 pb-6 border-t border-white/10 flex items-center gap-3",
        className,
      )}
    >
      {children}
    </div>
  );
}
