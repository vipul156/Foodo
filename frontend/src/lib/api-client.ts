// ============================================================
// Foodo — API Client with Auth Interceptors
// ============================================================

const AUTH_SERVICE_URL = process.env.NEXT_PUBLIC_AUTH_SERVICE_URL || "http://localhost:3000/api/auth";
const RESTAURANT_SERVICE_URL = process.env.NEXT_PUBLIC_RESTAURANT_SERVICE_URL || "http://localhost:3001";
const RIDER_SERVICE_URL = process.env.NEXT_PUBLIC_RIDER_SERVICE_URL || "http://localhost:3000/rider";
const ADMIN_SERVICE_URL = process.env.NEXT_PUBLIC_ADMIN_SERVICE_URL || "http://localhost:3000/api";

// ─── Token Management ───────────────────────────────────────

const TOKEN_KEY = "foodo_auth_token";

export const getToken = (): string | null => {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
};

export const setToken = (token: string): void => {
  localStorage.setItem(TOKEN_KEY, token);
};

export const removeToken = (): void => {
  localStorage.removeItem(TOKEN_KEY);
};

// ─── Fetch Wrapper ──────────────────────────────────────────

interface FetchOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  params?: Record<string, string | number | undefined>;
}

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

async function request<T>(
  baseUrl: string,
  endpoint: string,
  options: FetchOptions = {},
): Promise<T> {
  const { body, params, headers: customHeaders, ...rest } = options;

  // Build URL with query params
  let url = `${baseUrl}${endpoint}`;
  if (params) {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) searchParams.append(key, String(value));
    });
    const qs = searchParams.toString();
    if (qs) url += `?${qs}`;
  }

  // Build headers
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(customHeaders as Record<string, string>),
  };

  // Attach auth token
  const token = getToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  // Build request
  const config: RequestInit = {
    ...rest,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  };

  const response = await fetch(url, config);

  // Handle errors
  if (!response.ok) {
    let errorData: unknown;
    try {
      errorData = await response.json();
    } catch {
      errorData = { message: response.statusText };
    }
    throw new ApiError(
      (errorData as { message?: string })?.message || "Request failed",
      response.status,
      errorData,
    );
  }

  return response.json() as Promise<T>;
}

// ─── Service-specific clients ───────────────────────────────

export const authApi = {
  get: <T>(endpoint: string, options?: FetchOptions) =>
    request<T>(AUTH_SERVICE_URL, endpoint, { ...options, method: "GET" }),
  post: <T>(endpoint: string, body?: unknown, options?: FetchOptions) =>
    request<T>(AUTH_SERVICE_URL, endpoint, { ...options, method: "POST", body }),
};

export const restaurantApi = {
  get: <T>(endpoint: string, options?: FetchOptions) =>
    request<T>(RESTAURANT_SERVICE_URL, endpoint, { ...options, method: "GET" }),
  post: <T>(endpoint: string, body?: unknown, options?: FetchOptions) =>
    request<T>(RESTAURANT_SERVICE_URL, endpoint, { ...options, method: "POST", body }),
  put: <T>(endpoint: string, body?: unknown, options?: FetchOptions) =>
    request<T>(RESTAURANT_SERVICE_URL, endpoint, { ...options, method: "PUT", body }),
  delete: <T>(endpoint: string, options?: FetchOptions) =>
    request<T>(RESTAURANT_SERVICE_URL, endpoint, { ...options, method: "DELETE" }),
};

export const riderApi = {
  get: <T>(endpoint: string, options?: FetchOptions) =>
    request<T>(RIDER_SERVICE_URL, endpoint, { ...options, method: "GET" }),
  post: <T>(endpoint: string, body?: unknown, options?: FetchOptions) =>
    request<T>(RIDER_SERVICE_URL, endpoint, { ...options, method: "POST", body }),
  patch: <T>(endpoint: string, body?: unknown, options?: FetchOptions) =>
    request<T>(RIDER_SERVICE_URL, endpoint, { ...options, method: "PATCH", body }),
  put: <T>(endpoint: string, body?: unknown, options?: FetchOptions) =>
    request<T>(RIDER_SERVICE_URL, endpoint, { ...options, method: "PUT", body }),
};

export const adminApi = {
  get: <T>(endpoint: string, options?: FetchOptions) =>
    request<T>(ADMIN_SERVICE_URL, endpoint, { ...options, method: "GET" }),
  patch: <T>(endpoint: string, body?: unknown, options?: FetchOptions) =>
    request<T>(ADMIN_SERVICE_URL, endpoint, { ...options, method: "PATCH", body }),
};

export { ApiError };
