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
  const { logout } = useAuthStore();
  const router = useRouter();

  return () => {
    logout();
    removeToken();
    router.push("/login");
  };
}
