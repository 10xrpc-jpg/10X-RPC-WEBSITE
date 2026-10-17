// 10X RPC — /api/rpc/rotate/skip — "Skip to next RPC" (Task 87)
// Immediately advances Auto Rotate by ONE position. Task 113 — LIFECYCLE: the
// counter still only tells the deterministic rotation formula to move one
// step ahead, and this route ALSO applies the enabled-flag switch instantly:
// the previous RPC's flag goes OFF, the next member's goes ON (exactly the
// member the daemon now publishes) — DB, UI switches and Discord stay in
// sync with no waiting for the next tick. No other config field is read or
// written.
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
import { reconcileRpcRotationFlags } from '@/lib/rpc-rotation-lifecycle'
import { ensureRpcConfiguredColumn, visibleRpcRows } from '@/lib/rpc-configured'

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
    // Portable SQL (no LEAST/GREATEST — SQLite daemons / local dev lack
    // them): read → clamp → write, identical to the Game skip route.
    const nextSkip = Math.min(1_000_000_000, Number(cfg.rpcRotateSkip) || 0) + 1
    await db.$executeRaw`
      UPDATE "GlobalConfig"
      SET "rpcRotateSkip" = ${nextSkip}
      WHERE "userId" = ${session.userId}`

    const refreshed = await db.globalConfig.findUnique({ where: { userId: session.userId } })

    // Task 113 — instant lifecycle switch: disable the previous member, enable
    // the member the advanced clock now points at (the one Discord shows).
    try {
      await ensureRpcConfiguredColumn()
      const rows = visibleRpcRows(await db.rpcConfig.findMany({
        where: { userId: session.userId },
        orderBy: [{ slot: 'asc' }, { createdAt: 'asc' }],
      }))
      const v = rotateSettingsView(refreshed)
      await reconcileRpcRotationFlags(
        session.userId,
        { enabled: true, secs: v.secs, order: v.order, skip: v.skip, refMs: v.refMs, slots: v.slots, seed: session.userId },
        rows.map(r => ({ id: r.id as string, enabled: !!r.enabled, createdAtMs: new Date(r.createdAt as Date).getTime() })),
        Date.now(),
        !!session.rpcEnabled,
      )
    } catch (e: unknown) {
      console.warn('rotate skip: lifecycle reconcile failed (daemon tick will reconcile):', e instanceof Error ? e.message : e)
    }

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
