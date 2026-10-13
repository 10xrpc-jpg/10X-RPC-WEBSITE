// 10X RPC — /api/rpc/slots — list & create RPC slots (max 3 per user)
// Multi-RPC: each user manages up to 3 INDEPENDENT RPC configurations. Each
// slot has its own fields, its own Application ID and its own enabled flag.
// Existing single-RPC users keep working untouched (their row = slot 1).
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { MAX_RPC_SLOTS, normalizeRpcSlots, nextFreeSlot, serializeSlot } from '@/lib/rpc-slots'
import { rotateSettingsView } from '@/lib/rpc-rotate-settings'

export const dynamic = 'force-dynamic'

/** GET — list all slots + Auto Rotate settings + the isolated game state. */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

  const rows = await normalizeRpcSlots(session.userId)
  const globalConfig = await db.globalConfig.findUnique({ where: { userId: session.userId } })
  const enabledGame = await db.gameConfig.findFirst({
    where: { userId: session.userId, enabled: true },
  })

  return NextResponse.json({
    ok: true,
    maxSlots: MAX_RPC_SLOTS,
    slots: rows.map(serializeSlot),
    autoRotate: rotateSettingsView(globalConfig),
    game: enabledGame
      ? { slug: enabledGame.gameSlug, name: enabledGame.gameName, enabled: enabledGame.enabled }
      : null,
  })
}

/** POST — "Add RPC": create the next slot (up to 3). Never touches other slots. */
export async function POST() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

    const rows = await normalizeRpcSlots(session.userId)
    const slot = nextFreeSlot(rows)
    if (slot === null) {
      return NextResponse.json(
        { ok: false, error: 'max_slots', message: `Maximum ${MAX_RPC_SLOTS} RPCs per account.` },
        { status: 409 }
      )
    }

    const created = await db.rpcConfig.create({
      data: {
        userId: session.userId,
        slot,
        name: '10X RPC',
        type: 'PLAYING',
        platform: 'desktop',
        startMinsAgo: 0,
        enabled: false,
      },
    })

    // Creating an idle slot must not disturb anything running — no sync needed.
    return NextResponse.json({ ok: true, slot, rpcConfig: serializeSlot(created) })
  } catch (e: unknown) {
    console.error('Error creating RPC slot:', e instanceof Error ? e.message : e)
    return NextResponse.json({ ok: false, error: 'create_failed' }, { status: 500 })
  }
}
