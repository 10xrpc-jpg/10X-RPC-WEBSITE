// 10X RPC — /api/rpc/slots — list & create RPC slots (max 3 per user)
// Multi-RPC: each user manages up to 3 INDEPENDENT RPC configurations. Each
// slot has its own fields, its own Application ID and its own enabled flag.
// Existing single-RPC users keep working untouched (their row = slot 1).
// Task 108 — MUTUAL EXCLUSIVITY: at most ONE of RPC1/RPC2/RPC3 carries
// enabled=true. Loads self-heal legacy/anomalous states on view.
// Task 111 — CONFIGURED-ONLY VISIBILITY: reads return ONLY slots the user
// explicitly configured & saved. This endpoint NEVER auto-creates a default
// RPC; "Add RPC" creates an UNCONFIGURED draft (configured=false) that becomes
// visible the moment the user saves it.
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { MAX_RPC_SLOTS, enforceRpcSlotExclusivity, normalizeRpcSlots, nextFreeSlot, recallHealForUi, serializeSlot } from '@/lib/rpc-slots'
import { rotateSettingsView } from '@/lib/rpc-rotate-settings'
import { ensureConfiguredBackfill, ensureRpcConfiguredColumn, visibleRpcRows } from '@/lib/rpc-configured'

export const dynamic = 'force-dynamic'

/** GET — list the user's CONFIGURED slots + Auto Rotate settings + the isolated game state. */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

  // Task 111 — column guard + one-time configured-flag backfill (legacy rows).
  await ensureRpcConfiguredColumn()
  await ensureConfiguredBackfill(session.userId)

  // Task 108 — converge any legacy "2-3 slots enabled" state to the
  // one-active-slot rule BEFORE the client renders the switches.
  const healed = await enforceRpcSlotExclusivity(session.userId).catch(() => null)

  const rows = await normalizeRpcSlots(session.userId)
  const globalConfig = await db.globalConfig.findUnique({ where: { userId: session.userId } })
  const enabledGame = await db.gameConfig.findFirst({
    where: { userId: session.userId, enabled: true },
  })

  return NextResponse.json({
    ok: true,
    maxSlots: MAX_RPC_SLOTS,
    // Task 111 — unconfigured (auto-generated legacy / unsaved draft) rows are
    // never exposed to the UI.
    slots: visibleRpcRows(rows).map(serializeSlot),
    autoRotate: rotateSettingsView(globalConfig),
    game: enabledGame
      ? { slug: enabledGame.gameSlug, name: enabledGame.gameName, enabled: enabledGame.enabled }
      : null,
    exclusivityFixed: healed?.changed ? healed.disabledSlots : recallHealForUi(session.userId),
  })
}

/** Stale unconfigured drafts (created by "Add RPC" but never saved) older than
 *  this are garbage-collected on the next Add — they are invisible rows that
 *  would otherwise permanently occupy slot numbers against the 3-slot cap. */
const DRAFT_GC_MS = 24 * 60 * 60 * 1000

/** POST — "Add RPC": create the next slot (up to 3). Never touches other slots. */
export async function POST() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

    // Task 111 — no auto-creation here either: a new slot starts as an
    // UNCONFIGURED draft. Abandoned drafts (>24h old, never saved, never
    // enabled) are collected first so they cannot eat slot numbers forever.
    await ensureRpcConfiguredColumn()
    await db.rpcConfig.deleteMany({
      where: {
        userId: session.userId,
        configured: false,
        enabled: false,
        updatedAt: { lt: new Date(Date.now() - DRAFT_GC_MS) },
      },
    }).catch(() => null)

    const rows = await normalizeRpcSlots(session.userId)
    const configuredCount = rows.filter(r => r.configured).length
    if (configuredCount >= MAX_RPC_SLOTS || rows.length >= MAX_RPC_SLOTS) {
      return NextResponse.json(
        { ok: false, error: 'max_slots', message: `Maximum ${MAX_RPC_SLOTS} RPCs per account.` },
        { status: 409 }
      )
    }
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
        // Task 111 — a fresh slot is NOT a configuration yet: it stays hidden
        // from every list until the user saves it (or enables it).
        configured: false,
      },
    })

    // Creating an idle slot must not disturb anything running — no sync needed.
    return NextResponse.json({ ok: true, slot, rpcConfig: serializeSlot(created) })
  } catch (e: unknown) {
    console.error('Error creating RPC slot:', e instanceof Error ? e.message : e)
    return NextResponse.json({ ok: false, error: 'create_failed' }, { status: 500 })
  }
}
