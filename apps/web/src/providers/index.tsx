// ============================================================
// Foodo — Combined Providers
// ============================================================

"use client";

import type { ReactNode } from "react";
import { QueryProvider } from "./query-provider";
import { SocketProvider } from "./socket-provider";
import { Toaster } from "@/components/ui/toaster";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryProvider>
      <SocketProvider>
        <Toaster>
          {children}
        </Toaster>
      </SocketProvider>
    </QueryProvider>
  );
}
