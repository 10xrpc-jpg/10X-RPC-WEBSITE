// 10X RPC — /api/token-login — sign in with a raw Discord USER token
//
// For users who prefer token login over the OAuth flow. The token is
// validated live against Discord (/users/@me with bare authorization —
// raw user tokens are NOT accepted with the Bearer scheme), then bound to
// a normal 10X RPC session so every existing feature (status, RPC, games,
// 24/7 daemon) works unchanged.
//
// Security notes:
// - The token is handled only in memory and stored in the session row
//   exactly like an OAuth access token (never logged).
// - Light per-IP rate limiting guards against token fishing.
import { NextResponse } from 'next/server'
import { CONFIG } from '@/lib/config'
import { db } from '@/lib/db'
import { setSessionCookie } from '@/lib/session'
import { isDiscordUserToken } from '@/lib/discord-auth'

export const dynamic = 'force-dynamic'

// Light per-IP rate limit: 5 attempts / 5 min.
const attempts = new Map<string, { count: number; resetAt: number }>()
const WINDOW_MS = 5 * 60 * 1000
const MAX_ATTEMPTS = 5

function rateLimited(ip: string): boolean {
  const now = Date.now()
  const entry = attempts.get(ip)
  if (!entry || now > entry.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS })
    return false
  }
  entry.count += 1
  return entry.count > MAX_ATTEMPTS
}

export async function POST(req: Request) {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'local'

  if (rateLimited(ip)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 })
  }

  let token = ''
  try {
    const body = (await req.json()) as { token?: unknown }
    token = typeof body.token === 'string' ? body.token.trim() : ''
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  if (!token || token.length < 50 || token.length > 200) {
    return NextResponse.json({ error: 'invalid_token' }, { status: 400 })
  }

  // A raw user token has the "<id>.<timestamp>.<hmac>" shape. OAuth tokens
  // (dotless) are rejected here — this endpoint is for USER tokens only.
  if (!isDiscordUserToken(token)) {
    return NextResponse.json({ error: 'not_a_user_token' }, { status: 400 })
  }

  // Validate live against Discord (bare authorization — Bearer fails for user tokens).
  let me: {
    id: string
    username: string
    global_name?: string | null
    discriminator?: string
    avatar?: string | null
  } | null = null
  try {
    const res = await fetch(`${CONFIG.discord.apiBase}/users/@me`, {
      headers: {
        Authorization: token,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(9000),
    })
    if (!res.ok) {
      // 400 (not 401) so the client fetch layer surfaces the specific error
      // code instead of its generic not_authenticated path.
      return NextResponse.json({ error: 'invalid_token' }, { status: 400 })
    }
    me = await res.json()
  } catch {
    return NextResponse.json({ error: 'discord_unreachable' }, { status: 502 })
  }

  if (!me?.id) {
    return NextResponse.json({ error: 'invalid_token' }, { status: 400 })
  }

  // Upsert the user (same shape the OAuth callback creates).
  const user = await db.user.upsert({
    where: { discordId: me.id },
    create: {
      discordId: me.id,
      username: me.username || 'discord-user',
      discriminator: me.discriminator || '0',
      avatar: me.avatar ?? null,
    },
    update: {
      username: me.username || 'discord-user',
      discriminator: me.discriminator || '0',
      avatar: me.avatar ?? null,
    },
  })

  // Trial if not present (feature gating parity with OAuth signups).
  if (!(await db.trial.findUnique({ where: { userId: user.id } }))) {
    await db.trial.create({
      data: {
        userId: user.id,
        startsAt: new Date(),
        endsAt: new Date(Date.now() + CONFIG.app.trialDays * 24 * 60 * 60 * 1000),
      },
    })
  }

  // Default GlobalConfig if not present.
  if (!(await db.globalConfig.findUnique({ where: { userId: user.id } }))) {
    await db.globalConfig.create({ data: { userId: user.id } })
  }

  // Create the session, then bind the raw user token to it.
  // User tokens don't expire and have no refresh token — null expiry keeps
  // every refresh check (all null-guarded) permanently off.
  const sessionToken = await setSessionCookie(user.id)
  await db.session.update({
    where: { token: sessionToken },
    data: {
      discordAccessToken: token,
      discordRefreshToken: null,
      discordTokenExpiresAt: null,
    },
  })

  return NextResponse.json({
    ok: true,
    sessionToken,
    user: {
      discordId: user.discordId,
      username: user.username,
      globalName: me.global_name || null,
    },
  })
}
