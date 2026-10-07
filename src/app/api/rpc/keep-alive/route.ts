// 10X RPC — /api/rpc/keep-alive — 24/7 presence refresh for ALL active users
// Called by cron / self-ping every 5 minutes.
//
// SLOW-UPDATE FIX: this route used to push presence DIRECTLY from Vercel via
// applyPresence() — creating a competing Discord gateway session next to the
// 24/7 daemon's session (stale overwrites / flapping profile). Now it simply
// notifies the presence backend (24/7 daemon in production) to sync each user
// from the DB — one session, one source of truth.
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { syncPresence } from '@/lib/presence-sync'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: Request) {
  const secret = process.env.KEEP_ALIVE_SECRET
  if (secret) {
    const auth = req.headers.get('authorization') || ''
    const provided = auth.replace(/^Bearer\s+/i, '')
    if (provided !== secret) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
  }

  const now = new Date()
  const results: Array<{ userId: string; username: string; ok: boolean; message: string }> = []

  // Find all sessions with RPC enabled AND a Discord access token
  const activeSessions = await db.session.findMany({
    where: {
      rpcEnabled: true,
      discordAccessToken: { not: null },
      expiresAt: { gt: now },
    },
    include: {
      user: true,
    },
  })

  for (const session of activeSessions) {
    try {
      // Check sleep timer — skip if sleep timer has expired
      if (session.sleepTimerActive && session.sleepTimerEndsAt && session.sleepTimerEndsAt < now) {
        await db.session.update({
          where: { id: session.id },
          data: {
            sleepTimerActive: false,
            sleepTimerEndsAt: null,
            rpcEnabled: false,
            gatewayReady: false,
            vrStatusActive: false,
          },
        })
        results.push({
          userId: session.userId,
          username: session.user.username,
          ok: true,
          message: 'Sleep timer expired — RPC disabled',
        })
        continue
      }

      // Re-sync presence from DB via the presence backend
      const result = await syncPresence(session.userId)

      results.push({
        userId: session.userId,
        username: session.user.username,
        ok: result.ok,
        message: result.message,
      })
    } catch (e) {
      results.push({
        userId: session.userId,
        username: session.user.username,
        ok: false,
        message: e instanceof Error ? e.message : 'unknown error',
      })
    }
  }

  return NextResponse.json({
    ok: true,
    totalActive: activeSessions.length,
    successCount: results.filter(r => r.ok).length,
    failCount: results.filter(r => !r.ok).length,
    results,
    at: now.toISOString(),
  })
}
