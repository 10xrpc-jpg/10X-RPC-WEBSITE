// 10X RPC — /api/rpc/rotate/skip — "Skip to next RPC" (Task 87)
// Immediately advances Auto Rotate by ONE position. Runtime-only: no slot
// config is read or written, no enabled flag flips — the counter merely tells
// the deterministic rotation formula to move one step ahead.
//
// ANCHOR RULE: the rotation clock anchor is GlobalConfig.updatedAt. A regular
// Prisma update would bump updatedAt and RESET the anchor (rotation would
// jump to an arbitrary position instead of "the next one"). So the counter is
// incremented via raw SQL WITHOUT touching updatedAt — the position advances
// by exactly +1 from wherever the clock is right now, and the daemon picks it
// up within one tick (≤10s) or instantly via the sync notification.
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { syncPresence } from '@/lib/presence-sync'
import { rotateSettingsView } from '@/lib/rpc-rotate-settings'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function POST() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ ok: false, error: 'not_authenticated' }, { status: 401 })

    const cfg = await db.globalConfig.findUnique({ where: { userId: session.userId } })
    if (!cfg || !cfg.rpcAutoRotate) {
      return NextResponse.json(
        { ok: false, error: 'rotation_off', message: 'Auto Rotate is not enabled.' },
        { status: 409 }
      )
    }

    // Raw SQL on purpose — preserves updatedAt (the rotation anchor).
    await db.$executeRaw`
      UPDATE "GlobalConfig"
      SET "rpcRotateSkip" = LEAST("rpcRotateSkip" + 1, 1000000000)
      WHERE "userId" = ${session.userId}`

    const refreshed = await db.globalConfig.findUnique({ where: { userId: session.userId } })

    // Instant push — without this the switch lands within the daemon's 10s
    // tick anyway; with it the next RPC appears in ~1s.
    let syncNote = ''
    if (session.discordAccessToken && session.rpcEnabled) {
      const res = await syncPresence(session.userId)
      syncNote = res.ok ? '' : ' (daemon will apply it within 10s)'
    }

    const view = rotateSettingsView(refreshed)
    return NextResponse.json({
      ok: true,
      autoRotate: view,
      message: `Skipped to the next RPC${syncNote}`,
    })
  } catch (e: unknown) {
    console.error('Error skipping rotation:', e instanceof Error ? e.message : e)
    return NextResponse.json({ ok: false, error: 'rotate_skip_failed' }, { status: 500 })
  }
}
