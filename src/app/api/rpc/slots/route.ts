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
import { ensureConfiguredBackfill, ensureRpcConfiguredColumn, rowLooksConfigured, visibleRpcRows } from '@/lib/rpc-configured'

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

/** POST — "Add RPC": create the next slot (up to 3). Never touches other slots. */
export async function POST() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

    // Task 111 — no auto-creation here either: a new slot starts as an
    // UNCONFIGURED draft. Abandoned drafts are invisible rows that would
    // otherwise permanently occupy slot numbers against the 3-slot cap.
    await ensureRpcConfiguredColumn()

    // Task 114 — the backfill MUST run BEFORE the reclaim: it stamps
    // configured=true onto legacy rows that carry REAL user-entered content
    // (they would otherwise look reclaimable while the persisted flag is still
    // false). Memoized per user — a no-op after the first dashboard load.
    await ensureConfiguredBackfill(session.userId)

    // Task 114 — RECLAIM INVISIBLE DRAFTS before counting. Every row with
    // configured=false + enabled=false is abandoned junk BY CONSTRUCTION:
    // a real config save (PUT) and an enable toggle both stamp configured=true,
    // and nothing ever flips it back — so such a row can never be visible or
    // live again. The old 24h age gate made a fresh abandoned draft block
    // "Add RPC" for a full day (user-visible as "Failed to add RPC" with no
    // explanation, because the 409 never reached the UI message). Invisible
    // placeholder rows must never eat slot numbers: collect them on every Add.
    // Belt & suspenders: rowLooksConfigured is checked too, so even a row the
    // backfill could not stamp (exotic client) is only reclaimed when it is
    // byte-identical to an auto-generated placeholder.
    const reclaimCandidates = await db.rpcConfig.findMany({
      where: { userId: session.userId, configured: false, enabled: false },
      select: { id: true },
    }).catch(() => [] as Array<{ id: string }>)
    if (reclaimCandidates.length > 0) {
      const full = await db.rpcConfig.findMany({
        where: { userId: session.userId, id: { in: reclaimCandidates.map(r => r.id) } },
      }).catch(() => [])
      const junkIds = full
        .filter(r => !rowLooksConfigured(r))
        .map(r => r.id)
      if (junkIds.length > 0) {
        await db.rpcConfig.deleteMany({ where: { id: { in: junkIds } } }).catch(() => null)
      }
    }

    const rows = await normalizeRpcSlots(session.userId)
    const configuredCount = rows.filter(r => r.configured).length
    // The real cap the user perceives: 3 CONFIGURED (visible) RPCs. After the
    // reclaim above every remaining row is configured, but keep the defensive
    // rows.length check so a concurrent Add in another tab can never push a
    // user past 3 total rows either.
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

    // Race guard (two tabs adding at the same moment): if a concurrent request
    // created a row at this slot between our read and our write, retry once
    // with a fresh slot allocation instead of failing the user's action.
    let created: Awaited<ReturnType<typeof db.rpcConfig.create>> | null = null
    for (let attempt = 0; attempt < 2 && !created; attempt++) {
      try {
        created = await db.rpcConfig.create({
          data: {
            userId: session.userId,
            slot: attempt === 0 ? slot : nextFreeSlot(await normalizeRpcSlots(session.userId)) ?? slot,
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
      } catch (raceErr) {
        // Last attempt exhausted → surface a real error; otherwise loop retries.
        if (attempt === 1) throw raceErr
      }
    }
    if (!created) {
      return NextResponse.json(
        { ok: false, error: 'create_failed', message: 'Could not create the RPC — please try again.' },
        { status: 500 }
      )
    }

    // Creating an idle slot must not disturb anything running — no sync needed.
    return NextResponse.json({ ok: true, slot, rpcConfig: serializeSlot(created) })
  } catch (e: unknown) {
    console.error('Error creating RPC slot:', e instanceof Error ? e.message : e)
    return NextResponse.json(
      { ok: false, error: 'create_failed', message: 'Could not create the RPC — please try again.' },
      { status: 500 }
    )
  }
}
