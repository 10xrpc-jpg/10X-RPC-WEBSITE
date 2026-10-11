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
  { source: "/uptime", destination: "/" },
  { source: "/oauth-consent", destination: "/" },
  { source: "/login", destination: "/" },
  { source: "/admin", destination: "/" },
];

const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Security headers (all responses). CSP keeps Next hydration working by
  // allowing inline scripts/styles; everything else is locked to same-origin
  // (images may load from any HTTPS host: users set custom background/image URLs).
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains",
          },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "script-src-attr 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob: https: http:",
              "media-src 'self' data: blob: https:",
              "font-src 'self' data:",
              "connect-src 'self'",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "frame-ancestors 'none'",
            ].join("; "),
          },
        ],
      },
    ];
  },
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
