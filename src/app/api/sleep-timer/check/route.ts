// 10X RPC — /api/sleep-timer/check — auto-expire sleep timers that have elapsed
// Called by cron or self-ping. For each session with an expired sleep timer:
//   - Clear RPC state (rpcEnabled=false, gatewayReady=false)
//   - Clear sleepTimerActive + sleepTimerEndsAt
//   - Clear any enabled RpcConfig.enabled flag
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { clientIp, isRateLimited } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

// Per-IP safety net (in case SLEEP_TIMER_TICK_SECRET is not configured on a
// given deployment): the check sweeps every session with an active timer.
const TICK_RATE = { max: 4, windowMs: 60_000 }

export async function POST(req: Request) {
  if (isRateLimited(`sleep-timer-check:${clientIp(req)}`, TICK_RATE.max, TICK_RATE.windowMs)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 })
  }

  const secret = process.env.SLEEP_TIMER_TICK_SECRET
  if (secret) {
    const auth = req.headers.get('authorization') || ''
    const provided = auth.replace(/^Bearer\s+/i, '')
    if (provided !== secret) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
  }

  const now = new Date()
  const expired: string[] = []

  // Find sessions with active but expired sleep timers
  const expiredSessions = await db.session.findMany({
    where: {
      sleepTimerActive: true,
      sleepTimerEndsAt: { lte: now },
    },
  })

  for (const session of expiredSessions) {
    try {
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
      // Disable BOTH modes' enabled flags — Normal RPC (RpcConfig) and Gamer
      // RPC (GameConfig). Only flags flip: both configurations' saved field
      // data is preserved and remembered for the next session.
      await Promise.all([
        db.rpcConfig.updateMany({
          where: { userId: session.userId, enabled: true },
          data: { enabled: false },
        }),
        db.gameConfig.updateMany({
          where: { userId: session.userId, enabled: true },
          data: { enabled: false },
        }),
      ])
      expired.push(session.id)
    } catch (e) {
      console.error(`Failed to expire sleep timer for session ${session.id}:`, e)
    }
  }

  return NextResponse.json({
    ok: true,
    expiredCount: expired.length,
    expired,
    at: now.toISOString(),
  })
}
