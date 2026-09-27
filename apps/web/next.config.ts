import type { NextConfig } from "next";
import path from "path";

const isDev = process.env.NODE_ENV === "development";

// ─── Backend endpoints ───────────────────────────────────────
// Every HTTP route lives on ONE shared API Gateway (the foodo-core-api
// stack): /api/auth/*, /api/restaurant/*, /api/rider/*, /api/admin/*,
// /api/utils/*. Set API_GATEWAY_URL to the foodo-core-api-<stage>-HttpApiUrl
// CloudFormation export for local development (Next rewrites proxy to it,
// keeping requests same-origin so session cookies flow).
const API_GATEWAY_URL = process.env.API_GATEWAY_URL;

// Realtime is a separate API Gateway WebSocket API (foodorealtime-<stage>
// WebSocketUrl export) — consumed directly by the browser via
// NEXT_PUBLIC_REALTIME_WS_URL (see src/lib/socket.ts). No HTTP proxy.

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**.amazonaws.com",
      },
      {
        protocol: "https",
        hostname: "res.cloudinary.com",
      },
    ],
  },

  turbopack: {
    // Monorepo: pin the workspace root so turbopack detects @foodo/*
    // workspace packages correctly.
    root: path.join(__dirname, "../.."),
  },

  async rewrites() {
    if (!isDev || !API_GATEWAY_URL) {
      // Production: requests hit the API Gateway directly (same-origin
      // via custom domain or configured CORS on the gateway).
      return [];
    }

    // Development only: proxy everything to the deployed gateway so
    // cookies stay first-party.
    return [
      {
        source: "/api/:path*",
        destination: `${API_GATEWAY_URL}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
