// ============================================================
// Foodo — Auth Feature: TanStack Query API Hooks
// ============================================================

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { authApi, setToken, removeToken } from "@/lib/api-client";
import { useAuthStore } from "@/store/auth-store";
import type {
  IAuthResponse,
  ILoginPayload,
  IRegisterPayload,
  IUser,
} from "@/types";

// ─── Login ───────────────────────────────────────────────────

export function useLogin() {
  const { setUser } = useAuthStore();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: ILoginPayload) => {
      const res = await authApi.post<IAuthResponse>("/login", data);
      return res;
    },
    onSuccess: (data) => {
      setUser(data.user);
      setToken(data.token || "");
      queryClient.invalidateQueries({ queryKey: ["auth"] });
    },
  });
}

// ─── Register ────────────────────────────────────────────────

export function useRegister() {
  const { setUser } = useAuthStore();

  return useMutation({
    mutationFn: async (data: IRegisterPayload) => {
      const res = await authApi.post<IAuthResponse>("/register", data);
      return res;
    },
    onSuccess: (data) => {
      setUser(data.user);
      setToken(data.token || "");
    },
  });
}

// ─── Get Current User ────────────────────────────────────────

export function useCurrentUser() {
  const { setUser, setLoading } = useAuthStore();

  return useQuery({
    queryKey: ["auth", "me"],
    queryFn: async () => {
      const res = await authApi.get<{ message: string; user: IUser }>("/me");
      setUser(res.user);
      return res.user;
    },
    retry: false,
    staleTime: 1000 * 60 * 5,
    meta: {
      onSettled: () => setLoading(false),
    },
  });
}

// ─── Logout ──────────────────────────────────────────────────

export function useLogout() {
  const router = useRouter();
  const { logout: clearAuthState } = useAuthStore();

  return () => {
    try {
      // 1. Clear auth store (resets user, isAuthenticated, isLoading)
      clearAuthState();

      // 2. Remove JWT token from localStorage
      removeToken();

      // 3. Clear Zustand persist storage explicitly
      if (typeof window !== "undefined") {
        localStorage.removeItem("foodo-auth");
      }

      // 4. Invalidate all queries to prevent stale data
      // (queryClient access requires useQueryClient, so we fall back to hard navigation)

      // 5. Navigate to login — use hard navigation to ensure clean state
      try {
        router.push("/login");
      } catch {
        // Fallback if router is unavailable (e.g., during SSR or edge cases)
        if (typeof window !== "undefined") {
          window.location.href = "/login";
        }
      }
    } catch (error) {
      console.error("[Logout] Error during logout:", error);
      // Fallback: force navigation even if cleanup fails
      if (typeof window !== "undefined") {
        localStorage.removeItem("foodo_auth_token");
        localStorage.removeItem("foodo-auth");
        window.location.href = "/login";
      }
    }
  };
}
