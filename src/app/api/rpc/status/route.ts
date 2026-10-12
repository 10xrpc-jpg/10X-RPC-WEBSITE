// 10X RPC — /api/rpc/status — set user status (online/idle/dnd/invisible) via 24/7 Gateway
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { syncPresence } from '@/lib/presence-sync'
import { normalizeStatusForPlatform } from '@/lib/constants'

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
  // ── VR/MOBILE BADGE FIX: a badge platform (Mobile/VR) is only visible while
  // online — auto-switch idle/dnd so the icon always shows.
  const storedStatus = normalizeStatusForPlatform(
    session.statusPlatform || 'mobile',
    status,
    !!session.vrStatusActive
  )
  const autoOnline = storedStatus !== status
  await db.session.updateMany({
    where: { userId: session.userId },
    data: {
      userStatus: storedStatus,
      lastPresenceUpdate: new Date(),
    },
  })

  // Push immediately via Gateway Daemon only if Status is currently enabled
  if (session.statusEnabled && session.discordAccessToken) {
    await syncPresence(session.userId)

    return NextResponse.json({
      ok: true,
      status: storedStatus,
      autoOnline,
      message: autoOnline
        ? 'Mobile/VR badge needs Online — status switched to Online'
        : `Status set to ${storedStatus}`,
    })
  }

  // Demo mode
  return NextResponse.json({
    ok: true,
    status: storedStatus,
    autoOnline,
    message: 'Saved (demo mode — sign in with Discord to apply to Discord)',
  })
}
