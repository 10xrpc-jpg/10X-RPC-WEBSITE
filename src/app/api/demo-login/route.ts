// 10X RPC — /api/demo-login — create a demo user + session for preview
// Returns the session token so the frontend can redirect to /set-session
// to set the cookie on Vercel's domain (since the browser is on Vercel,
// not Render, and cookies can't be set cross-domain).
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { setSessionCookie } from '@/lib/session'
import { CONFIG } from '@/lib/config'
import { getTrialConfig } from '@/lib/trial-config'
import { clientIp, isRateLimited } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

// Per-IP rate limit: 10 demo sessions / 5 min — every POST creates a new
// Session row, so an unthrottled endpoint would let anyone bloat the DB.
const WINDOW_MS = 5 * 60 * 1000
const MAX_PER_WINDOW = 10

export async function POST(req: Request) {
  if (isRateLimited(`demo-login:${clientIp(req)}`, MAX_PER_WINDOW, WINDOW_MS)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 })
  }

  // Check if demo user already exists
  const demoDiscordId = 'demo-user-10x'
  let user = await db.user.findUnique({ where: { discordId: demoDiscordId } })

  // DB-backed global cap (works across serverless instances, unlike the
  // in-memory per-IP limiter above): every POST creates a Session row, so
  // the shared demo account must not be spammed with unbounded sessions.
  if (user) {
    const recentSessions = await db.session.count({
      where: { userId: user.id, createdAt: { gt: new Date(Date.now() - WINDOW_MS) } },
    })
    if (recentSessions >= 30) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429 })
    }
    // Housekeeping: prune hour-old demo sessions so the table stays bounded.
    await db.session.deleteMany({
      where: { userId: user.id, createdAt: { lt: new Date(Date.now() - 60 * 60 * 1000) } },
    }).catch(() => {})
  }

  if (!user) {
    user = await db.user.create({
      data: {
        discordId: demoDiscordId,
        username: 'DemoUser',
        discriminator: '0001',
        avatar: null,
        backgroundUrl: 'https://images.unsplash.com/photo-1614850523060-8da1d56ae167?w=1200&q=80',
      },
    })
    // Create trial
    await db.trial.create({
      data: {
        userId: user.id,
        startsAt: new Date(),
        endsAt: new Date(Date.now() + (await getTrialConfig()).days * 24 * 60 * 60 * 1000),
      },
    })
    // Create global config
    await db.globalConfig.create({
      data: { userId: user.id, city: 'Mumbai', timezone: 'Asia/Calcutta' }
    })
    // Create a default RPC config (intentional demo content — Task 111: the
    // demo preview needs a sample RPC, so it is explicitly marked configured;
    // real users never get an auto-created row like legacy builds did).
    await db.rpcConfig.create({
      data: {
        userId: user.id,
        name: 'Visual Studio Code',
        type: 'PLAYING',
        platform: 'desktop',
        state: 'Editing page.tsx',
        details: 'Workspace: 10X RPC',
        largeImage: 'vscode',
        largeText: 'VS Code',
        enabled: false,
        configured: true,
        partyCurrent: 1,
        partyMax: 5,
        startMinsAgo: 0,
        endTotalMins: 30,
      },
    })
    // Seed a couple of rotator presets
    await db.rotatorPreset.createMany({
      data: [
        { userId: user.id, emoji: '🎮', text: 'Playing something', durationMins: 5, order: 0 },
        { userId: user.id, emoji: '💻', text: 'Coding the future', durationMins: 5, order: 1 },
        { userId: user.id, emoji: '☕', text: 'Coffee break', durationMins: 5, order: 2 },
      ],
    })
  }

  // Subscription: the demo account is shared by every visitor, so its trial
  // window ROLLS on each demo login (never suspends mid-preview).
  const demoTrialDays = Math.max(1, (await getTrialConfig()).days)
  await db.subscription.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      plan: 'free',
      status: 'trialing',
      trialEndsAt: new Date(Date.now() + demoTrialDays * 24 * 60 * 60 * 1000),
      trialUsed: true,
    },
    update: {
      plan: 'free',
      status: 'trialing',
      trialEndsAt: new Date(Date.now() + demoTrialDays * 24 * 60 * 60 * 1000),
      suspendedAt: null,
    },
  })

  // Create session — setSessionCookie() also tries to set the cookie on Render's
  // domain (which won't reach the browser on Vercel), but we capture the token
  // and return it so the frontend can redirect to /set-session.
  const sessionToken = await setSessionCookie(user.id)

  return NextResponse.json({
    ok: true,
    demo: true,
    sessionToken, // Frontend will redirect to /set-session?token=xxx
    redirect: `/set-session?token=${encodeURIComponent(sessionToken)}`,
  })
}
