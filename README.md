# 10X RPC

Premium Discord Rich Presence management dashboard.

## Features

- **Discord OAuth2 with PKCE** — secure server-side sessions, no tokens exposed to the browser
- **Live Discord RPC Preview** — see what your presence will look like in real Discord
- **Quick Status Panel** — instantly switch between Online/Idle/DND/Invisible + 6 quick custom status presets
- **Custom Background** — set any image URL as your profile card background
- **Smart Sleep Timer** — auto-disable RPC after a set number of hours
- **Status Rotator** — rotate through up to 20 custom status presets (configurable duration)
- **Game RPC Presets** — 12 games pre-configured (Minecraft, Genshin, Valorant, GTA V, CS2, etc.)
- **Per-Game Config** — enable RPC per game with custom state/details/images/buttons/party
- **Dynamic Placeholders** — `{time}`, `{weather}`, `{temp}`, `{city}`, `{uptime}`, `{countdown:HH:MM}`, etc.
- **Weather Engine** — Open-Meteo integration (no API key needed)
- **Global Config** — city + timezone + auto-detect
- **VR Status** — Meta Quest VR headset icon toggle
- **Trial System** — 3-day free trial with live countdown
- **24/7 Reliability** — session persistence in Neon Postgres + client-side keep-alive

## Tech Stack

- **Framework**: Next.js 16 (App Router)
- **Language**: TypeScript 5
- **Database**: PostgreSQL (Neon) + Prisma ORM
- **Styling**: Tailwind CSS 4 with custom glassmorphism theme
- **Auth**: Discord OAuth2 with PKCE + HMAC-signed cookies
- **Deploy**: Vercel

## Environment Variables

Set these in your Vercel project (or `.env` for local dev):

```bash
DATABASE_URL="postgresql://..."              # Neon Postgres connection string
DISCORD_CLIENT_ID="..."                       # Discord app client ID
DISCORD_CLIENT_SECRET="..."                   # Discord app client secret
DISCORD_BOT_TOKEN="..."                       # Discord bot token (optional, for gateway)
DISCORD_REDIRECT_URI="https://yourapp.vercel.app/auth/callback"
NEXT_PUBLIC_APP_URL="https://yourapp.vercel.app"
SESSION_SECRET="<random-48-byte-base64url>"   # Generate with: openssl rand -base64 48
DISCORD_OAUTH_SCOPE="openid identify email guilds sdk.social_layer_presence relationships.read"
```

## Local Development

```bash
# Install dependencies
bun install

# Push schema to database
bun run db:push

# Start dev server
bun run dev
```

## Deployment

This project is configured for Vercel:

```bash
# Install Vercel CLI
npm install -g vercel

# Deploy
vercel deploy --prod
```

The `postinstall` script automatically runs `prisma generate` on Vercel.

## Discord Setup

1. Go to https://discord.com/developers/applications
2. Create a new application
3. Set the redirect URI to: `https://yourapp.vercel.app/auth/callback`
4. Copy the Client ID, Client Secret, and (optionally) create a bot token
5. Set these as environment variables on Vercel

## Disclaimer

10X RPC is not affiliated with, endorsed, or sponsored by Discord Inc. Use at your own risk — Discord may ban accounts that abuse rich presence features.

## License

MIT
# 10X-RPC-WEBSITE-OAUTH_V2
