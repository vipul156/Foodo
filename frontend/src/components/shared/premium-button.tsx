// ============================================================
// Foodo — Premium Button (Animated, Gradient-Aware)
// ============================================================

"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";

interface PremiumButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "outline" | "danger";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  icon?: React.ReactNode;
  fullWidth?: boolean;
}

const PremiumButton = forwardRef<HTMLButtonElement, PremiumButtonProps>(
  (
    {
      className,
      variant = "primary",
      size = "md",
      loading = false,
      icon,
      fullWidth = false,
      children,
      disabled,
      ...props
    },
    ref,
  ) => {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cn(
          // Base
          "relative inline-flex items-center justify-center font-medium rounded-xl transition-all duration-200 select-none",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          "disabled:pointer-events-none disabled:opacity-50",
          "active:scale-[0.97]",

          // Sizes
          size === "sm" && "h-9 px-4 text-sm gap-1.5",
          size === "md" && "h-11 px-6 text-sm gap-2",
          size === "lg" && "h-13 px-8 text-base gap-2.5",

          // Width
          fullWidth && "w-full",

          // Variants
          variant === "primary" &&
            "bg-gradient-to-br from-primary to-primary/80 text-primary-foreground shadow-lg shadow-primary/25 hover:shadow-xl hover:shadow-primary/30 hover:brightness-110",
          variant === "secondary" &&
            "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
          variant === "ghost" &&
            "text-foreground hover:bg-accent hover:text-accent-foreground",
          variant === "outline" &&
            "border border-border bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground",
          variant === "danger" &&
            "bg-gradient-to-br from-destructive to-destructive/80 text-destructive-foreground shadow-lg shadow-destructive/25 hover:shadow-xl hover:shadow-destructive/30",

          className,
        )}
        {...props}
      >
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : icon ? (
          <span className="shrink-0">{icon}</span>
        ) : null}
        {children && <span>{children}</span>}
      </button>
    );
  },
);

PremiumButton.displayName = "PremiumButton";

export { PremiumButton };
