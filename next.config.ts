import type { NextConfig } from "next";

const RENDER_API_URL = process.env.RENDER_API_URL || "";

// Clean-URL SPA routing: the app is a single page (src/app/page.tsx) that
// routes on the URL pathname (no /#/ hash). These rewrites serve the same
// page shell for direct loads/refreshes of the client-side routes. Real
// routes (API handlers, static assets) are matched before these rewrites.
const SPA_SHELL_REWRITES = [
  { source: "/dashboard", destination: "/" },
  { source: "/profile", destination: "/" },
  { source: "/games", destination: "/" },
  { source: "/games/:slug", destination: "/" },
  { source: "/config", destination: "/" },
  { source: "/rotator", destination: "/" },
  { source: "/oauth-consent", destination: "/" },
  { source: "/login", destination: "/" },
  { source: "/admin", destination: "/" },
];

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
    if (!RENDER_API_URL) return SPA_SHELL_REWRITES;
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
      ...SPA_SHELL_REWRITES,
    ];
  },
};

export default nextConfig;
