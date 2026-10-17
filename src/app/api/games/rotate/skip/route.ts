// 10X RPC — /api/games/rotate/skip — "Skip to next game" (Task 95).
// Immediately advances the GAME Auto-Rotate by ONE position. Fully
// independent from the Normal RPC skip (/api/rpc/rotate/skip) — separate
// counter, separate endpoint, separate system.
//
// ANCHOR RULE: the counter is incremented via raw SQL WITHOUT touching
// updatedAt (the NORMAL rotation's clock anchor). The GAME rotation carries
// its own watermark (gameRotateAppliedSkip) — the daemon applies pending
// skips (skip − appliedSkip > 0) within one tick (≤10s) or instantly via the
// sync notification.
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { syncPresence } from '@/lib/presence-sync'
import { gameRotateSettingsView, reconcileGameRotationNow } from '@/lib/game-rotate-settings'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function POST() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ ok: false, error: 'not_authenticated' }, { status: 401 })

    const cfg = await db.globalConfig.findUnique({ where: { userId: session.userId } })
    if (!cfg || !cfg.gameRotateEnabled) {
      return NextResponse.json(
        { ok: false, error: 'rotation_off', message: 'Game Auto-Rotate is not enabled.' },
        { status: 409 }
      )
    }

    // Guard: with zero games there is nothing to advance into — bumping the
    // counter would only blank the rotation head (skip → null → re-seat).
    const gameCount = await db.gameConfig.count({ where: { userId: session.userId } })
    if (gameCount === 0) {
      return NextResponse.json(
        { ok: false, error: 'no_games', message: 'Add a game first — there is nothing to rotate yet.' },
        { status: 409 }
      )
    }

    // Raw SQL on purpose — preserves updatedAt (the NORMAL rotation anchor).
    // Portable SQL (no LEAST/GREATEST): read → clamp → write.
    const nextSkip = Math.min(1_000_000_000, Number(cfg.gameRotateSkip) || 0) + 1
    await db.$executeRaw`
      UPDATE "GlobalConfig"
      SET "gameRotateSkip" = ${nextSkip}
      WHERE "userId" = ${session.userId}`

    // INSTANT APPLY — re-derive the rotation decision right now (the same
    // pure function the daemon runs): pending skips advance the head, the
    // single-active flags flip, and the state persists immediately. Without
    // this the UI showed the OLD game for up to one daemon tick (≤10s).
    await reconcileGameRotationNow(session.userId).catch(() => null)

    const refreshed = await db.globalConfig.findUnique({ where: { userId: session.userId } })

    // Instant push — without this the switch lands within the daemon's 10s
    // tick anyway; with it the next game appears in ~1s.
    let syncNote = ''
    if (session.discordAccessToken && session.rpcEnabled) {
      const res = await syncPresence(session.userId).catch(() => null)
      syncNote = res?.ok ? '' : ' (daemon will apply it within 10s)'
    }

    const view = gameRotateSettingsView(refreshed)
    return NextResponse.json({
      ok: true,
      gameRotate: view,
      message: `Skipped to the next game${syncNote}`,
    })
  } catch (e: unknown) {
    console.error('Error skipping game rotation:', e instanceof Error ? e.message : e)
    return NextResponse.json({ ok: false, error: 'game_rotate_skip_failed' }, { status: 500 })
  }
}
