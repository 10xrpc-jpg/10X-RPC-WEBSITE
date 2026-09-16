// 10X RPC — /api/sleep-timer/check — auto-expire sleep timers that have elapsed
// Called by cron or self-ping. For each session with an expired sleep timer:
//   - Clear RPC state (rpcEnabled=false, gatewayReady=false)
//   - Clear sleepTimerActive + sleepTimerEndsAt
//   - Clear any enabled RpcConfig.enabled flag
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
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
      // Also disable any RpcConfig for this user
      await db.rpcConfig.updateMany({
        where: { userId: session.userId, enabled: true },
        data: { enabled: false },
      })
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
