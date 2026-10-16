// ============================================================
// Foodo — API Client (Axios + Next.js Rewrites)
// ============================================================
// All requests go through Next.js rewrites at /api/*
// Same-domain requests = cookies flow naturally.
// No Authorization headers needed — cookie-based auth only.
//
// Session model:
//   - Session cookie: 15-min minimal-claims JWT (sub + role), httpOnly
//   - Refresh cookie: 30-day opaque token, httpOnly, scoped to /api/auth
//   - On 401, requests transparently POST /api/auth/refresh once and retry

import axios from "axios";
import type { AxiosRequestConfig } from "axios";
import { getApiClient } from "./api";

// ─── Socket Token (in-memory only) ─────────────
// Socket.IO connects cross-origin, so it can't use cookies — it needs
// an explicit JWT in handshake.auth. The browser fetches a short-lived
// bootstrap token on demand (authenticated by the session cookie) and
// keeps it in memory only. Never sessionStorage/localStorage: any XSS
// could read those; memory dies with the page.

let socketToken: string | null = null;

export function getSocketToken(): string | null {
  return socketToken;
}

export function clearSocketToken(): void {
  socketToken = null;
}

export async function fetchSocketToken(): Promise<string | null> {
  if (socketToken) return socketToken;
  try {
    const res = await request<{ token: string }>("/api/auth/socket-token", {
      method: "GET",
    });
    socketToken = res.token;
    return socketToken;
  } catch {
    return null;
  }
}

// ─── Session refresh (single-flight) ───────────
// Concurrent 401s share one POST /api/auth/refresh; the httpOnly
// refresh cookie does the work, the response carries fresh cookies.
let refreshInFlight: Promise<void> | null = null;

export function refreshSession(): Promise<void> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        await request("/api/auth/refresh", { method: "POST" });
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

// ─── Error Type ─────────────────────────────────────────────

class ApiError extends Error {
  status: number;
  data: unknown;

  constructor(message: string, status: number, data?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

// Endpoints that must NOT trigger the 401 → refresh → retry dance
// (refresh is the retry mechanism itself; login/register don't need a
// session — retrying them can't help).
const AUTH_RETRY_EXEMPT = [
  "/api/auth/refresh",
  "/api/auth/login",
  "/api/auth/register",
];

async function requestOnce<T>(
  url: string,
  config: AxiosRequestConfig,
): Promise<T> {
  const client = getApiClient();
  try {
    const response = await client.request<T>({
      url,
      ...config,
    });
    return response.data;
  } catch (error: unknown) {
    if (axios.isAxiosError(error) && error.response) {
      throw new ApiError(
        error.response.data?.message || error.message || "Request failed",
        error.response.status,
        error.response.data,
      );
    }
    throw error;
  }
}

async function request<T>(
  url: string,
  config: AxiosRequestConfig = {},
): Promise<T> {
  try {
    return await requestOnce<T>(url, config);
  } catch (error: unknown) {
    // Access token expired (15-min TTL): refresh once, then replay the
    // original request. A second 401 propagates — the session is dead.
    const status = error instanceof ApiError ? error.status : undefined;
    const exempt = AUTH_RETRY_EXEMPT.some((p) => url.startsWith(p));
    if (status === 401 && !exempt) {
      try {
        await refreshSession();
      } catch {
        throw error; // refresh failed — surface the original 401
      }
      return requestOnce<T>(url, config);
    }
    throw error;
  }
}

// ─── Service-specific API Clients ───────────────────────────
// All use relative URLs which Next.js rewrites proxy to microservices.

export const authApi = {
  get: <T>(endpoint: string) =>
    request<T>(`/api/auth${endpoint}`, { method: "GET" }),
  post: <T>(endpoint: string, data?: unknown) =>
    request<T>(`/api/auth${endpoint}`, { method: "POST", data }),
};

export const restaurantApi = {
  get: <T>(endpoint: string, config?: AxiosRequestConfig) =>
    request<T>(`/api${endpoint}`, { method: "GET", ...config }),
  post: <T>(endpoint: string, data?: unknown, config?: AxiosRequestConfig) =>
    request<T>(`/api${endpoint}`, { method: "POST", data, ...config }),
  put: <T>(endpoint: string, data?: unknown, config?: AxiosRequestConfig) =>
    request<T>(`/api${endpoint}`, { method: "PUT", data, ...config }),
  patch: <T>(endpoint: string, data?: unknown, config?: AxiosRequestConfig) =>
    request<T>(`/api${endpoint}`, { method: "PATCH", data, ...config }),
  delete: <T>(endpoint: string, config?: AxiosRequestConfig) =>
    request<T>(`/api${endpoint}`, { method: "DELETE", ...config }),
};

export const riderApi = {
  get: <T>(endpoint: string) =>
    request<T>(`/api/rider${endpoint}`, { method: "GET" }),
  post: <T>(endpoint: string, data?: unknown) =>
    request<T>(`/api/rider${endpoint}`, { method: "POST", data }),
  patch: <T>(endpoint: string, data?: unknown) =>
    request<T>(`/api/rider${endpoint}`, { method: "PATCH", data }),
  put: <T>(endpoint: string, data?: unknown) =>
    request<T>(`/api/rider${endpoint}`, { method: "PUT", data }),
};

export const adminApi = {
  get: <T>(endpoint: string, config?: AxiosRequestConfig) =>
    request<T>(`/api/admin${endpoint}`, { method: "GET", ...config }),
  patch: <T>(endpoint: string, data?: unknown) =>
    request<T>(`/api/admin${endpoint}`, { method: "PATCH", data }),
};

export { ApiError };
