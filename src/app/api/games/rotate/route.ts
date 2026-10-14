// 10X RPC — /api/games/rotate — GAME Auto-Rotate settings (Task 95).
// A FULLY INDEPENDENT rotation system: it rotates GameConfig games only and
// shares NOTHING with the Normal RPC Auto-Rotate (/api/rpc/rotate) — no
// columns, no timers, no anchor, no state. Saving game-rotation settings
// never reads or writes rpcAutoRotate* and never touches RpcConfig.
//
// ANCHOR RULE: gameRotate* writes go through raw SQL that NEVER bumps
// GlobalConfig.updatedAt — updatedAt is the NORMAL rotation's clock anchor,
// so changing the GAME rotation must not reset the NORMAL rotation's phase
// (spec §3: "Changing the rotation interval in one system must not change
// the interval in the other system").
//
// Every field is OPTIONAL: missing fields keep their stored value (partial
// updates are safe — the UI may send only the field the user just changed).
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { syncPresence } from '@/lib/presence-sync'
import { normalizeRotateOrder, normalizeRotateSecs, rotateSecsLabel, type RotateOrder } from '@/lib/rotation'
import { buildGamePool } from '@/lib/game-rotation'
import {
  gameRotateSettingsView,
  persistGameRotationState,
  loadGameRows,
} from '@/lib/game-rotate-settings'
import { findGame } from '@/lib/games'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function GET() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ ok: false, error: 'not_authenticated' }, { status: 401 })
    const cfg = await db.globalConfig.findUnique({ where: { userId: session.userId } })
    return NextResponse.json({ ok: true, gameRotate: gameRotateSettingsView(cfg) })
  } catch (e: unknown) {
    console.error('Error reading game rotate settings:', e instanceof Error ? e.message : e)
    return NextResponse.json({ ok: false, error: 'game_rotate_read_failed' }, { status: 500 })
  }
}

/** Sanitize an explicit game rotation pool: slugs only, deduped, capped 24.
 *  Preset slugs are validated against GAME_PRESETS; custom slugs must belong
 *  to the user (a row must exist). Unknown slugs are dropped. */
async function sanitizeGameSlots(raw: unknown, userId: string): Promise<string[] | null> {
  if (!Array.isArray(raw)) return null
  const candidates: string[] = []
  for (const v of raw) {
    if (typeof v !== 'string') continue
    const k = v.trim().slice(0, 96)
    if (k && !candidates.includes(k)) candidates.push(k)
    if (candidates.length >= 24) break
  }
  if (candidates.length === 0) return []
  const customs = candidates.filter(s => s.startsWith('custom-'))
  const owned = new Set(
    (await db.gameConfig.findMany({
      where: { userId, gameSlug: { in: customs } },
      select: { gameSlug: true },
    })).map(r => r.gameSlug),
  )
  return candidates.filter(s => (s.startsWith('custom-') ? owned.has(s) : !!findGame(s)))
}

export async function POST(req: Request) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ ok: false, error: 'not_authenticated' }, { status: 401 })
    const userId = session.userId

    const body = await req.json().catch(() => ({})) as {
      enabled?: boolean
      secs?: number
      order?: string
      slots?: string[] | null
    }

    const existing = await db.globalConfig.findUnique({ where: { userId } })
    const prev = gameRotateSettingsView(existing)
    const enabled = body.enabled === undefined ? prev.enabled : !!body.enabled
    const secs = body.secs === undefined ? prev.secs : normalizeRotateSecs(body.secs)
    const order: RotateOrder = body.order === undefined ? prev.order : normalizeRotateOrder(body.order)
    const slots = body.slots === undefined ? prev.slots : await sanitizeGameSlots(body.slots, userId)

    // Ensure a GlobalConfig row exists WITHOUT bumping updatedAt when it
    // already does (create-if-missing only, then raw-SQL update).
    if (!existing) {
      await db.globalConfig.create({ data: { userId } })
    }

    // Raw SQL — updatedAt (the NORMAL rotation anchor) stays frozen.
    await db.$executeRaw`
      UPDATE "GlobalConfig"
      SET "gameRotateEnabled" = ${enabled},
          "gameRotateSecs" = ${secs},
          "gameRotateOrder" = ${order},
          "gameRotateSlots" = ${slots ? JSON.stringify(slots) : null}
      WHERE "userId" = ${userId}`

    // Enabling with no valid current → seat the rotation head NOW so the
    // first switch happens a full interval from this moment. Disabling keeps
    // every saved config exactly as it is (rotation is runtime-only over the
    // enabled flag; saved game configs are 100% read-only to this route).
    if (enabled) {
      const [gameRows, refreshed] = await Promise.all([
        loadGameRows(userId),
        db.globalConfig.findUnique({ where: { userId } }),
      ])
      const view = gameRotateSettingsView(refreshed)
      const pool = buildGamePool(gameRows, view.slots)
      const currentValid = !!view.current && gameRows.some(g => g.gameSlug === view.current)
      if (!currentValid) {
        const seat = pool[0] ?? null
        await persistGameRotationState(userId, {
          current: seat,
          anchorMs: Date.now(),
          appliedSkip: view.skip, // watermark = current counter (nothing pending)
        })
        if (seat) {
          // Single-active invariant — exactly the seated game runs.
          await db.gameConfig.updateMany({
            where: { userId, enabled: true, gameSlug: { not: seat } },
            data: { enabled: false },
          })
          await db.gameConfig.updateMany({
            where: { userId, gameSlug: seat },
            data: { enabled: true },
          })
        }
      }
    }

    // Runtime change — rebuild what is being sent immediately. This sync
    // NEVER flips Normal RPC anything; the daemon reconciles game flags.
    if (session.discordAccessToken && session.rpcEnabled) {
      await syncPresence(userId).catch(() => {})
    }

    const refreshed = await db.globalConfig.findUnique({ where: { userId } })
    const view = gameRotateSettingsView(refreshed)
    const message = view.enabled
      ? `Game Auto-Rotate ON — your selected games switch every ${rotateSecsLabel(view.secs)} (${view.order === 'shuffle' ? 'shuffled order' : `${view.order} order`})`
      : 'Game Auto-Rotate OFF — manual game selection, no automatic switching'

    return NextResponse.json({ ok: true, gameRotate: view, message })
  } catch (e: unknown) {
    console.error('Error saving game rotate settings:', e instanceof Error ? e.message : e)
    return NextResponse.json({ ok: false, error: 'game_rotate_save_failed' }, { status: 500 })
  }
}
