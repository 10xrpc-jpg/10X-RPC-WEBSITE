// 10X RPC — /api/rpc/status — set user status (online/idle/dnd/invisible) via 24/7 Gateway
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { syncPresence } from '@/lib/presence-sync'
import { BADGE_PLATFORMS } from '@/lib/constants'

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
  // ── IDLE/DND ⇒ NONE: the status is asserted here, so a Mobile/VR badge is
  // automatically saved as None (Discord hides badges behind idle/dnd glyphs).
  const badgeActive = !!session.vrStatusActive || BADGE_PLATFORMS.has(session.statusPlatform || 'mobile')
  const autoNone = badgeActive && (status === 'idle' || status === 'dnd')
  await db.session.updateMany({
    where: { userId: session.userId },
    data: {
      userStatus: status,
      lastPresenceUpdate: new Date(),
      ...(autoNone ? { statusPlatform: 'desktop', vrStatusActive: false } : {}),
    },
  })

  // Push immediately via Gateway Daemon only if Status is currently enabled
  if (session.statusEnabled && session.discordAccessToken) {
    await syncPresence(session.userId)

    return NextResponse.json({
      ok: true,
      status,
      autoNone,
      message: autoNone
        ? 'Idle/DND hides the VR/Mobile badge — icon saved as None'
        : `Status set to ${status}`,
    })
  }

  // Demo mode
  return NextResponse.json({
    ok: true,
    status,
    autoNone,
    message: 'Saved (demo mode — sign in with Discord to apply to Discord)',
  })
}
