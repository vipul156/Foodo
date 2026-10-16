// ============================================================
// Foodo — Socket Provider (connects on auth, disconnects on logout)
// ============================================================

"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { useAuthStore } from "@/store/auth-store";
import { connectSocket, disconnectSocket } from "@/lib/socket";

export function SocketProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuthStore();
  const previousAuthRef = useRef(isAuthenticated);

  useEffect(() => {
    try {
      // Connect when user becomes authenticated (auth via session cookie)
      if (isAuthenticated) {
        connectSocket();
      }

      // Disconnect when user logs out (was authenticated, now not)
      if (previousAuthRef.current && !isAuthenticated) {
        disconnectSocket();
      }

      previousAuthRef.current = isAuthenticated;
    } catch (error) {
      console.error("[SocketProvider] Error managing socket:", error);
    }

    // Cleanup on unmount
    return () => {
      disconnectSocket();
    };
  }, [isAuthenticated]);

  return <>{children}</>;
}
