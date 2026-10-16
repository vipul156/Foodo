// ============================================================
// Foodo — Axios API Client (Cookie-Based Auth)
// ============================================================
// Pattern from @ticketing156/common:
//   - Server-side: forward req.headers so cookies reach microservices
//   - Browser-side: use relative URLs through Next.js rewrites (same domain = cookies work)

import axios from "axios";
import type { IncomingMessage } from "http";

interface BuildClientParams {
  req?: IncomingMessage;
}

/**
 * Build an Axios instance configured for either server-side or browser-side.
 *
 * - On the **server** (SSR), we forward the incoming request's headers
 *   (including cookies) so the session is preserved when calling microservices.
 *
 * - On the **browser**, all requests go through Next.js rewrites at `/api/*`
 *   which proxy to the appropriate microservice. Same domain = cookies sent automatically.
 */
export function buildClient({ req }: BuildClientParams = {}) {
  if (typeof window === "undefined" && req) {
    // ── Server-side ──────────────────────────────────────────
    // Forward the incoming request's headers (cookies, etc.) directly to microservices
    return axios.create({
      baseURL: "http://localhost:3000",
      headers: req.headers as Record<string, string>,
    });
  }

  // ── Browser-side ───────────────────────────────────────────
  // Relative URLs — proxied through Next.js rewrites to microservices
  return axios.create({
    baseURL: "",
    withCredentials: true, // sends cookies (SameSite cookies work on same domain)
  });
}

// Singleton browser instance (most common usage)
let browserClient: ReturnType<typeof axios.create> | null = null;

export function getApiClient(req?: IncomingMessage) {
  if (typeof window === "undefined") {
    return buildClient({ req });
  }
  if (!browserClient) {
    browserClient = buildClient();
  }
  return browserClient;
}
