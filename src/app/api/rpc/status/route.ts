// 10X RPC — /api/rpc/status — set user status (online/idle/dnd/invisible) via 24/7 Gateway
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { ensureDaemonRunning } from '@/lib/rpc-daemon'

export const dynamic = 'force-dynamic'
export const maxDuration = 15

export async function POST(req: Request) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ ok: false, error: 'not_authenticated' }, { status: 401 })
  }

  const body = await req.json() as { status?: string }
  const status = body.status || 'online'

  if (!['online', 'idle', 'dnd', 'invisible'].includes(status)) {
    return NextResponse.json(
      { ok: false, error: 'invalid_status', message: 'Must be: online, idle, dnd, or invisible' },
      { status: 400 }
    )
  }

  // Persist to session (completely independent from rpcEnabled and rpcConfig)
  await db.session.updateMany({
    where: { userId: session.userId },
    data: {
      userStatus: status,
      lastPresenceUpdate: new Date(),
    },
  })

  // Push immediately via Gateway Daemon only if Status is currently enabled
  if (session.statusEnabled && session.discordAccessToken) {
    const daemon = ensureDaemonRunning()
    await daemon.syncUser(session.userId)

    return NextResponse.json({
      ok: true,
      status,
      message: `Status set to ${status}`,
    })
  }

  // Demo mode
  return NextResponse.json({
    ok: true,
    status,
    message: 'Saved (demo mode — sign in with Discord to apply to Discord)',
  })
}
