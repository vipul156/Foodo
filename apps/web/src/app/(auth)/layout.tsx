// ============================================================
// Foodo — Auth Group Layout
// ============================================================

import type { ReactNode } from "react";
import Link from "next/link";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center bg-background">
      {/* Background decorative elements */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 h-80 w-80 rounded-full bg-primary/5 blur-3xl dark:bg-primary/10" />
        <div className="absolute -bottom-40 -left-40 h-80 w-80 rounded-full bg-primary/5 blur-3xl dark:bg-primary/10" />
      </div>

      {/* Logo */}
      <div className="mb-8 xl:hidden">
        <Link
          href="/"
          className="text-3xl font-bold tracking-tight text-foreground"
        >
          <span className="text-primary">Foodo</span>
        </Link>
      </div>

      {/* Content */}
      <div className="relative w-full max-w-md px-4">
        <div className="rounded-2xl border border-white/20 bg-white/70 backdrop-blur-xl shadow-xl shadow-black/5 dark:border-white/10 dark:bg-black/40 dark:shadow-black/20 p-8">
          {children}
        </div>
      </div>
    </div>
  );
}
