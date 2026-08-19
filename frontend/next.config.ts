import type { NextConfig } from "next";
import path from "path";

const isDev = process.env.NODE_ENV === "development";

const AUTH_SERVICE_URL =
  process.env.AUTH_SERVICE_URL || "http://localhost:3001";
const RESTAURANT_SERVICE_URL =
  process.env.RESTAURANT_SERVICE_URL || "http://localhost:3003";
const RIDER_SERVICE_URL =
  process.env.RIDER_SERVICE_URL || "http://localhost:3004";
const ADMIN_SERVICE_URL =
  process.env.ADMIN_SERVICE_URL || "http://localhost:3006";
const REALTIME_SERVICE_URL =
  process.env.REALTIME_SERVICE_URL || "http://localhost:3002";
const UTILS_SERVICE_URL =
  process.env.UTILS_SERVICE_URL || "http://localhost:3005";

const nextConfig: NextConfig = {
  output: "standalone",

  turbopack: {
    root: path.join(__dirname),
  },

  async rewrites() {
    if (!isDev) {
      // Production: Nginx handles proxying.
      return [];
    }

    // Development only.
    return [
      {
        source: "/api/auth/:path*",
        destination: `${AUTH_SERVICE_URL}/api/auth/:path*`,
      },
      {
        source: "/api/restaurant/:path*",
        destination: `${RESTAURANT_SERVICE_URL}/api/restaurant/:path*`,
      },
      {
        source: "/api/menu-item/:path*",
        destination: `${RESTAURANT_SERVICE_URL}/api/menu-item/:path*`,
      },
      {
        source: "/api/cart/:path*",
        destination: `${RESTAURANT_SERVICE_URL}/api/cart/:path*`,
      },
      {
        source: "/api/order/:path*",
        destination: `${RESTAURANT_SERVICE_URL}/api/order/:path*`,
      },
      {
        source: "/api/address/:path*",
        destination: `${RESTAURANT_SERVICE_URL}/api/address/:path*`,
      },
      {
        source: "/api/rider/:path*",
        destination: `${RIDER_SERVICE_URL}/api/rider/:path*`,
      },
      {
        source: "/api/admin/:path*",
        destination: `${ADMIN_SERVICE_URL}/api/admin/:path*`,
      },
      {
        source: "/api/internal/:path*",
        destination: `${REALTIME_SERVICE_URL}/api/internal/:path*`,
      },
      {
        source: "/api/utils/:path*",
        destination: `${UTILS_SERVICE_URL}/api/utils/:path*`,
      },
    ];
  },
};

export default nextConfig;
