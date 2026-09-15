// ============================================================
// Foodo — API Client (Axios + Next.js Rewrites)
// ============================================================
// All requests go through Next.js rewrites at /api/*
// Same-domain requests = cookies flow naturally.
// No Authorization headers needed — cookie-based auth only.

import axios from "axios";
import type { AxiosRequestConfig } from "axios";
import { getApiClient } from "./api";

// ─── Socket Token (in-memory + sessionStorage) ───────────────
// HTTP API calls use cookie-based auth through Next.js proxy.
// Socket.IO needs an explicit token via handshake.auth.
// We store it in sessionStorage (cleared on tab close) so it
// survives page refreshes but not new tab/window opens.

const SOCKET_TOKEN_KEY = "foodo_socket_token";

function getStoredToken(): string | null {
  if (typeof window !== "undefined") {
    return sessionStorage.getItem(SOCKET_TOKEN_KEY);
  }
  return null;
}

function setStoredToken(token: string): void {
  if (typeof window !== "undefined") {
    sessionStorage.setItem(SOCKET_TOKEN_KEY, token);
  }
}

function clearStoredToken(): void {
  if (typeof window !== "undefined") {
    sessionStorage.removeItem(SOCKET_TOKEN_KEY);
  }
}

export function getSocketToken(): string | null {
  return getStoredToken();
}

export function setSocketToken(token: string): void {
  setStoredToken(token);
}

export function clearSocketToken(): void {
  clearStoredToken();
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

// ─── Generic Request Helper ─────────────────────────────────

async function request<T>(
  url: string,
  config: AxiosRequestConfig = {},
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
  get: <T>(endpoint: string) =>
    request<T>(`/api/admin${endpoint}`, { method: "GET" }),
  patch: <T>(endpoint: string, data?: unknown) =>
    request<T>(`/api/admin${endpoint}`, { method: "PATCH", data }),
};

export { ApiError };
