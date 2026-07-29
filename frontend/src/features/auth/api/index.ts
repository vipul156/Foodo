// ============================================================
// Foodo — Auth Feature: TanStack Query API Hooks
// ============================================================

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { authApi, setSocketToken, clearSocketToken } from "@/lib/api-client";
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
      if (data.token) setSocketToken(data.token);
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
      if (data.token) setSocketToken(data.token);
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

  return async () => {
    try {
      // 1. Call server logout to clear the session cookie
      await authApi.post("/logout");
    } catch {
      // Ignore server errors — we still clear local state
    }

    // Clear the socket token from sessionStorage
    clearSocketToken();

    try {
      // 2. Clear auth store (resets user, isAuthenticated, isLoading)
      clearAuthState();

      // 3. Clear Zustand persist storage explicitly
      if (typeof window !== "undefined") {
        localStorage.removeItem("foodo-auth");
      }

      // 4. Navigate to login — use hard navigation to ensure clean state
      try {
        router.push("/login");
      } catch {
        if (typeof window !== "undefined") {
          window.location.href = "/login";
        }
      }
    } catch (error) {
      console.error("[Logout] Error during logout:", error);
      if (typeof window !== "undefined") {
        localStorage.removeItem("foodo-auth");
        window.location.href = "/login";
      }
    }
  };
}
