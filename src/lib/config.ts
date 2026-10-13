// 10X RPC — Central configuration
// All secrets come from environment variables in production.

export const CONFIG = {
  discord: {
    clientId: process.env.DISCORD_CLIENT_ID || '',
    clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
    botToken: process.env.DISCORD_BOT_TOKEN || '',
    // The redirect_uri MUST point to the Render backend (where /auth/callback runs).
    // This must match what's registered in Discord Developer Portal.
    redirectUri: process.env.DISCORD_REDIRECT_URI || 'http://localhost:3000/auth/callback',
    // Gaming SDK scope — required for the Gaming SDK gateway connection.
    scope: process.env.DISCORD_OAUTH_SCOPE || 'openid identify sdk.social_layer_presence',
    authorizeUrl: 'https://discord.com/api/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    apiBase: 'https://discord.com/api/v9',
    // Gaming SDK gateway — accepts OAuth2 user tokens with sdk.social_layer_presence scope.
    gatewayUrl: 'wss://gateway.gaming-sdk.com/?v=10&encoding=json',
    serverId: process.env.DISCORD_SERVER_ID || '1549302358926823496',
    // Auto-join: every website login (OAuth2 with guilds.join scope) also adds
    // the user to this Discord server via the bot's Add Guild Member API.
    autoJoinGuildId: process.env.DISCORD_AUTO_JOIN_GUILD_ID || '1540998891971805185',
    inviteUrl: process.env.DISCORD_INVITE_URL || 'https://discord.gg/FZvJfZx2V5',
  },
  app: {
    name: '10X RPC',
    tagline: 'Premium Discord Rich Presence',
    // app.url = where the user's browser is. After OAuth callback, redirect here.
    // On Render: set NEXT_PUBLIC_APP_URL to the Vercel frontend URL (so callback redirects to Vercel).
    // On Vercel: NEXT_PUBLIC_APP_URL = the Vercel URL itself (default).
    url: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
    // Free trial length for new signups (Subscription lifecycle).
    trialDays: 3,
  },
  razorpay: {
    // Live keys live in env (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET /
    // RAZORPAY_WEBHOOK_SECRET). keyId is safe to expose to the browser for
    // Checkout.js — the key secret never leaves the server.
    keyId: process.env.RAZORPAY_KEY_ID || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
    apiBase: 'https://api.razorpay.com/v1',
    checkoutSrc: 'https://checkout.razorpay.com/v1/checkout.js',
    currency: 'INR',
    // Self-serve paid plans (amount in paise). The periodDays extend the
    // Subscription.currentPeriodEnd (stacks on top of any remaining time).
    plans: {
      plus: { label: 'Plus', amount: 19900, periodDays: 30, display: '₹199', period: '/ 1 Mo' },
      pro: { label: 'Pro', amount: 39900, periodDays: 90, display: '₹399', period: '/ 3 Mo' },
    } as Record<'plus' | 'pro', { label: string; amount: number; periodDays: number; display: string; period: string }>,
  },
  weather: {
    geocodeUrl: 'https://geocoding-api.open-meteo.com/v1/search',
    forecastUrl: 'https://api.open-meteo.com/v1/forecast',
  },
  session: {
    cookieName: '10x_rpc_session',
    ttlDays: 7,
    secret: process.env.SESSION_SECRET || '10x-rpc-dev-secret-change-me-in-production-32bytes-min',
  },
  admin: {
    // Discord user IDs with admin access. Overridable via ADMIN_DISCORD_IDS
    // (comma-separated) so the privileged list can rotate without a code
    // change; the fallback preserves current production behavior.
    discordIds: (() => {
      const fromEnv = (process.env.ADMIN_DISCORD_IDS || '')
        .split(',')
        .map(id => id.trim())
        .filter(Boolean)
      return fromEnv.length > 0 ? fromEnv : ['824940038617694279']
    })(),
  },
}

export type AppConfig = typeof CONFIG
