import { Request } from "express";

/**
 * Resolves the client's frontend origin dynamically from the incoming request.
 * Prioritizes standard headers forwarded by CloudFront / reverse proxy,
 * followed by process.env.FRONTEND_URL, with local dev as the final fallback.
 */
export function getFrontendOrigin(req: Request): string {
  const origin = req.headers.origin;
  if (origin) {
    return Array.isArray(origin) ? origin[0] : origin;
  }

  const forwardedHost = req.headers["x-forwarded-host"];
  if (forwardedHost) {
    const host = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost;
    const proto = req.headers["x-forwarded-proto"] || "https";
    return `${proto}://${host}`;
  }

  const host = req.headers.host;
  if (host) {
    const isLocal = host.startsWith("localhost") || host.startsWith("127.0.0.1");
    return `${isLocal ? "http" : "https"}://${host}`;
  }

  return process.env.FRONTEND_URL || "http://localhost:3000";
}
