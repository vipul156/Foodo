import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",

  async rewrites() {
    return [
      // ── Auth Service (port 3001) ──────────────────────────
      {
        source: "/api/auth/:path*",
        destination: "http://localhost:3001/api/auth/:path*",
      },

      // ── Restaurant Service (port 3003) ─────────────────────
      {
        source: "/api/restaurant/:path*",
        destination: "http://localhost:3003/restaurant/:path*",
      },
      {
        source: "/api/menu-item/:path*",
        destination: "http://localhost:3003/menu-item/:path*",
      },
      {
        source: "/api/cart/:path*",
        destination: "http://localhost:3003/cart/:path*",
      },
      {
        source: "/api/order/:path*",
        destination: "http://localhost:3003/order/:path*",
      },
      {
        source: "/api/address/:path*",
        destination: "http://localhost:3003/address/:path*",
      },

      // ── Rider Service (port 3004) ─────────────────────────
      {
        source: "/api/rider/:path*",
        destination: "http://localhost:3004/rider/:path*",
      },

      // ── Admin Service (port 3006) ──────────────────────────
      {
        source: "/api/admin/:path*",
        destination: "http://localhost:3006/api/:path*",
      },

      // ── Realtime Service (port 3002) — internal routes ─────
      {
        source: "/api/internal/:path*",
        destination: "http://localhost:3002/api/v1/internal/:path*",
      },

      // ── Utils Service (port 3005) — payment, cloudinary ────
      {
        source: "/api/utils/:path*",
        destination: "http://localhost:3005/:path*",
      },

    ];
  },
};

export default nextConfig;
