import type { NextConfig } from "next";

const RENDER_API_URL = process.env.RENDER_API_URL || "";

const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // When RENDER_API_URL is set (Vercel frontend-only deployment),
  // proxy all API + auth requests to the Render backend.
  // This keeps cookies same-origin (browser talks to Vercel, Vercel forwards to Render).
  // When RENDER_API_URL is NOT set (Render deployment), no rewrites — Render serves everything.
  async rewrites() {
    if (!RENDER_API_URL) return [];
    return [
      {
        source: "/api/cron/:path*",
        destination: "/api/cron/:path*",
      },
      {
        source: "/api/:path*",
        destination: `${RENDER_API_URL}/api/:path*`,
      },
      {
        source: "/auth/:path*",
        destination: `${RENDER_API_URL}/auth/:path*`,
      },
    ];
  },
};

export default nextConfig;
