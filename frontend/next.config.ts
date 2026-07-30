import type { NextConfig } from "next";
import path from "path";

// Define base URLs with fallbacks to localhost defaults
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || "http://localhost:3001";
const REALTIME_SERVICE_URL = process.env.REALTIME_SERVICE_URL || "http://localhost:3002";
const RESTAURANT_SERVICE_URL = process.env.RESTAURANT_SERVICE_URL || "http://localhost:3003";
const RIDER_SERVICE_URL = process.env.RIDER_SERVICE_URL || "http://localhost:3004";
const UTILS_SERVICE_URL = process.env.UTILS_SERVICE_URL || "http://localhost:3005";
const ADMIN_SERVICE_URL = process.env.ADMIN_SERVICE_URL || "http://localhost:3006";

const nextConfig: NextConfig = {
  output: "standalone",
 turbopack: {
    root: path.join(__dirname),
  },
  async rewrites() {
    return [
      // ── Auth Service ──────────────────────────
      {
        source: "/api/auth/:path*",
        destination: `${AUTH_SERVICE_URL}/api/auth/:path*`,
      },

      // ── Restaurant Service ─────────────────────
      {
        source: "/api/restaurant/:path*",
        destination: `${RESTAURANT_SERVICE_URL}/restaurant/:path*`,
      },
      {
        source: "/api/menu-item/:path*",
        destination: `${RESTAURANT_SERVICE_URL}/menu-item/:path*`,
      },
      {
        source: "/api/cart/:path*",
        destination: `${RESTAURANT_SERVICE_URL}/cart/:path*`,
      },
      {
        source: "/api/order/:path*",
        destination: `${RESTAURANT_SERVICE_URL}/order/:path*`,
      },
      {
        source: "/api/address/:path*",
        destination: `${RESTAURANT_SERVICE_URL}/address/:path*`,
      },

      // ── Rider Service ─────────────────────────
      {
        source: "/api/rider/:path*",
        destination: `${RIDER_SERVICE_URL}/rider/:path*`,
      },

      // ── Admin Service ──────────────────────────
      {
        source: "/api/admin/:path*",
        destination: `${ADMIN_SERVICE_URL}/api/:path*`,
      },

      // ── Realtime Service ─────
      {
        source: "/api/internal/:path*",
        destination: `${REALTIME_SERVICE_URL}/api/v1/internal/:path*`,
      },

      // ── Utils Service ────
      {
        source: "/api/utils/:path*",
        destination: `${UTILS_SERVICE_URL}/:path*`,
      },
    ];
  },
};

export default nextConfig;