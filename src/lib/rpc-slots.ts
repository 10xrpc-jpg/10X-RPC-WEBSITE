// 10X RPC — Multi-RPC slots helpers (max 3 independent RPC configs per user)
// Shared by /api/rpc/slots* routes. The DB is the single source of truth for
// each slot's fields AND its own enabled flag; these helpers only normalize
// slot numbers and serialize rows for the client.

import { db } from '@/lib/db'
import { isGameApplicationId } from '@/lib/games'
import { rowLooksConfigured } from '@/lib/rpc-configured'

export const MAX_RPC_SLOTS = 3

export type SlotRow = Awaited<ReturnType<typeof db.rpcConfig.findFirst>> & { slot: number }

/**
 * Normalize a user's RpcConfig rows to contiguous-ish slots 1..3.
 *
 * Existing users (single-RPC era) have exactly one row — it becomes slot 1
 * via the column default. Defensive pass: rows with slot out of range or
 * duplicated slots are re-assigned by createdAt order so the UI can always
 * render stable "RPC n" cards. Never touches fields or enabled flags.
 */
export async function normalizeRpcSlots(userId: string): Promise<SlotRow[]> {
  const rows = await db.rpcConfig.findMany({
    where: { userId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })

  const used = new Set<number>()
  const needFix: Array<{ id: string; slot: number }> = []
  for (const r of rows) {
    const s = (r as { slot?: number }).slot
    if (typeof s === 'number' && s >= 1 && s <= MAX_RPC_SLOTS && !used.has(s)) {
      used.add(s)
    } else {
      needFix.push({ id: r.id, slot: 0 })
    }
  }
  // Assign the lowest free slot to each row needing a fix (createdAt order).
  let cursor = 1
  for (const fix of needFix) {
    while (used.has(cursor) && cursor <= MAX_RPC_SLOTS) cursor++
    fix.slot = cursor <= MAX_RPC_SLOTS ? cursor : cursor // overflow rows keep a >3 marker; capped rows are enforced on create
    used.add(fix.slot)
  }

  await Promise.all(
    needFix
      .filter(f => {
        const row = rows.find(r => r.id === f.id) as { slot?: number } | undefined
        return row && row.slot !== f.slot
      })
      .map(f =>
        db.rpcConfig.update({ where: { id: f.id }, data: { slot: f.slot } }).catch(() => null)
      )
  )

  return rows
    .map(r => {
      const fixed = needFix.find(f => f.id === r.id)
      return { ...(r as SlotRow), slot: fixed ? fixed.slot : (r as { slot?: number }).slot ?? 1 }
    })
    .sort((a, b) => a.slot - b.slot)
}

/** Lowest free slot number 1..3, or null when the user already has 3. */
export function nextFreeSlot(rows: Array<{ slot: number }>): number | null {
  const used = new Set(rows.map(r => r.slot))
  for (let s = 1; s <= MAX_RPC_SLOTS; s++) {
    if (!used.has(s)) return s
  }
  return null
}

/** Serialize a slot row for the client (same shape as /api/me rpcConfig).
 *  Task 111 — carries the persisted `configured` flag so the frontend and the
 *  backend share the same configuration-state truth (heuristic fallback for
 *  rows whose flag predates the column). */
export function serializeSlot(cfg: Record<string, unknown> & { slot: number }) {
  return {
    id: cfg.id,
    slot: cfg.slot,
    configured: (cfg as { configured?: boolean }).configured ?? rowLooksConfigured(cfg as unknown as Parameters<typeof rowLooksConfigured>[0]),
    name: cfg.name,
    type: cfg.type,
    platform: cfg.platform,
    state: cfg.state,
    details: cfg.details,
    largeImage: cfg.largeImage,
    largeText: cfg.largeText,
    smallImage: cfg.smallImage,
    smallText: cfg.smallText,
    button1Label: cfg.button1Label,
    button1Url: cfg.button1Url,
    button2Label: cfg.button2Label,
    button2Url: cfg.button2Url,
    partyCurrent: cfg.partyCurrent,
    partyMax: cfg.partyMax,
    partyId: cfg.partyId,
    partySecret: cfg.partySecret,
    startMinsAgo: cfg.startMinsAgo,
    endTotalMins: cfg.endTotalMins,
    // Game catalog ids on a normal slot are bad legacy rows — present as
    // unset so the UI and the daemon agree on the 10X default resolution.
    appId: isGameApplicationId(cfg.appId as string | null | undefined) ? null : (cfg.appId as string | null),
    enabled: cfg.enabled,
  }
}

/** True when at least one enabled candidate remains (any slot or the game). */
export async function anyEnabledCandidate(userId: string): Promise<boolean> {
  const [slotCount, gameCount] = await Promise.all([
    db.rpcConfig.count({ where: { userId, enabled: true } }),
    db.gameConfig.count({ where: { userId, enabled: true } }),
  ])
  return slotCount + gameCount > 0
}

/**
 * Task 106 — ROTATION COVERAGE. True when Auto Rotate is ON and its stored
 * EXPLICIT selection matches at least one EXISTING slot of the user (enabled
 * or not) — i.e. the rotator still has a member to publish even though no
 * slot (or no slot other than the one being disabled/deleted) is enabled.
 *
 * Used by the toggle/delete paths: flipping the last enabled slot OFF or
 * deleting it must NOT tear the presence down while the Auto Rotator still
 * cycles through selected slots — the selection is independent of the
 * per-slot enabled flags (that is the whole point of Task 106).
 * A null/unset selection means the legacy "every ENABLED slot rotates" rule,
 * which the enabled-count check already covers → false here.
 */
export async function rotationCoversAnySlot(userId: string): Promise<boolean> {
  try {
    const gc = await db.globalConfig.findUnique({
      where: { userId },
      select: { rpcAutoRotate: true, rpcRotateSlots: true },
    })
    if (!gc?.rpcAutoRotate) return false
    if (typeof gc.rpcRotateSlots !== 'string' || !gc.rpcRotateSlots.trim()) return false
    let keys: unknown
    try {
      keys = JSON.parse(gc.rpcRotateSlots)
    } catch {
      return false
    }
    if (!Array.isArray(keys) || keys.length === 0) return false
    const slotKeys = keys.filter(
      (k): k is string => typeof k === 'string' && k.length > 0 && !k.startsWith('game:')
    )
    if (slotKeys.length === 0) return false
    const rows = await db.rpcConfig.findMany({ where: { userId }, select: { id: true } })
    const ids = new Set(rows.map(r => r.id))
    return slotKeys.some(k => ids.has(k))
  } catch {
    return false
  }
}

// ═════════════════════════════════════════════════════════════════════════
// Task 108 — MUTUAL EXCLUSIVITY for RPC1 / RPC2 / RPC3
//
// At most ONE Normal RPC slot may carry enabled=true at any moment. Enabling
// a slot atomically disables the other slots (same DB transaction); Game RPC
// (GameConfig), Application RPC and every saved field are NEVER touched.
//
// Concurrency hardening (the "rapid switching / simultaneous requests"
// requirement):
//   • PostgreSQL (production): a per-user transaction-scoped advisory lock
//     serializes concurrent slot writes — two parallel enable requests can
//     never interleave into "two slots enabled".
//   • SQLite (local/sandbox): a single-writer engine — the interactive
//     transaction already serializes writers.
//   • Belt & suspenders: after every exclusive enable the committed state is
//     re-read; if a violation ever slipped through, the heal runs and keeps
//     only the intended slot.
// ═════════════════════════════════════════════════════════════════════════

type SlotTx = Parameters<Parameters<typeof db.$transaction>[0]>[0]

const SLOT_ORDER = [{ slot: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] as const

/** Serializable per-user slot transaction (advisory lock on PostgreSQL). */
export async function withSlotExclusivityTx<T>(
  userId: string,
  fn: (tx: SlotTx) => Promise<T>
): Promise<T> {
  return db.$transaction(async tx => {
    // PostgreSQL only: a transaction-scoped per-user advisory lock serializes
    // concurrent slot writes. SQLite (file: URLs — sandbox/local dev) is a
    // single-writer engine; the interactive transaction already serializes,
    // and the raw call would just error (no pg functions) — skip it entirely.
    const url = (process.env.DATABASE_URL || '').trim()
    if (!url.startsWith('file:')) {
      try {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}), 42069)`
      } catch {
        /* provider without pg functions — proceed under the engine's own lock */
      }
    }
    return fn(tx)
  }, { timeout: 15_000, maxWait: 5_000 })
}

export type ExclusiveEnableResult =
  | { ok: true; row: SlotRow; disabledSlots: number[]; disabledIds: string[] }
  | { ok: false; reason: 'slot_not_found' }
  | { ok: false; reason: 'tx_failed' }

/**
 * Enable ONE slot and disable every OTHER slot of the user — atomically.
 * Returns the auto-disabled slot numbers so callers can message the user and
 * sync the UI instantly. Never touches GameConfig or any configuration field.
 */
export async function enableSlotExclusively(
  userId: string,
  slotId: string
): Promise<ExclusiveEnableResult> {
  try {
    const result = await withSlotExclusivityTx(userId, async tx => {
      // Re-read INSIDE the serialized transaction — the authoritative check.
      const slot = await tx.rpcConfig.findFirst({ where: { id: slotId, userId } })
      if (!slot) return { ok: false as const, reason: 'slot_not_found' as const }

      const others = await tx.rpcConfig.findMany({
        where: { userId, id: { not: slotId }, enabled: true },
        orderBy: [...SLOT_ORDER],
      })
      if (others.length > 0) {
        await tx.rpcConfig.updateMany({
          where: { userId, id: { in: others.map(r => r.id) } },
          data: { enabled: false },
        })
      }
      const updated = await tx.rpcConfig.update({
        where: { id: slotId },
        // Task 111 — enabling is an EXPLICIT user action: the slot becomes a
        // real, visible configuration (it runs live on Discord from here on).
        data: { enabled: true, configured: true },
      })
      return {
        ok: true as const,
        row: updated as SlotRow,
        disabledSlots: others.map(r => (r as { slot?: number }).slot ?? 0),
        disabledIds: others.map(r => r.id),
      }
    })

    if (!result.ok) return result

    // Belt & suspenders: verify the COMMITTED state honors the invariant. If
    // an exotic race still produced 2+ enabled slots, heal keeping THIS slot.
    const stragglers = await db.rpcConfig.findMany({
      where: { userId, enabled: true, id: { not: slotId } },
      select: { id: true, slot: true },
    })
    if (stragglers.length > 0) {
      await db.rpcConfig.updateMany({
        where: { userId, id: { in: stragglers.map(r => r.id) } },
        data: { enabled: false },
      })
      return {
        ...result,
        disabledSlots: [...new Set([...result.disabledSlots, ...stragglers.map(r => (r as { slot?: number }).slot ?? 0)])],
        disabledIds: [...new Set([...result.disabledIds, ...stragglers.map(r => r.id)])],
      }
    }
    return result
  } catch (e) {
    console.error('enableSlotExclusively failed:', e instanceof Error ? e.message : e)
    return { ok: false, reason: 'tx_failed' }
  }
}

export type ExclusivityHealResult = {
  changed: boolean
  keepSlot: number | null
  disabledSlots: number[]
  disabledIds: string[]
}

// Task 108 — short-lived memory of a heal so REPEATED dashboard loads within
// the same moment (StrictMode double-mount, parallel tabs) still surface the
// one-time explanation toast even though the heal itself already converged.
const recentHeals = new Map<string, { slots: number[]; until: number }>()
const HEAL_MEMORY_MS = 15_000

function rememberHealForUi(userId: string, slots: number[]): void {
  recentHeals.set(userId, { slots, until: Date.now() + HEAL_MEMORY_MS })
  if (recentHeals.size > 5000) {
    const now = Date.now()
    for (const [k, v] of recentHeals) if (now > v.until) recentHeals.delete(k)
  }
}

/** Slot numbers healed for this user within the last HEAL_MEMORY_MS (or []). */
export function recallHealForUi(userId: string): number[] {
  const f = recentHeals.get(userId)
  if (!f) return []
  if (Date.now() > f.until) {
    recentHeals.delete(userId)
    return []
  }
  return f.slots
}

/**
 * Converge any state with 2+ enabled slots back to the one-active-slot rule.
 * Keeps `keepId` (or the lowest slot number when unspecified). Cheap no-op
 * (single indexed read) while the invariant already holds. Used by the
 * dashboard loads so legacy/anomalous states self-heal on the next page view.
 */
export async function enforceRpcSlotExclusivity(
  userId: string,
  keepId?: string
): Promise<ExclusivityHealResult> {
  const idle: ExclusivityHealResult = { changed: false, keepSlot: null, disabledSlots: [], disabledIds: [] }
  try {
    const enabledRows = await db.rpcConfig.findMany({
      where: { userId, enabled: true },
      orderBy: [...SLOT_ORDER],
    })
    if (enabledRows.length <= 1) {
      const keep = enabledRows[0] as { slot?: number } | undefined
      return { ...idle, keepSlot: keep ? keep.slot ?? 1 : null }
    }
    const keeper = (keepId && enabledRows.find(r => r.id === keepId)) || enabledRows[0]
    const losers = enabledRows.filter(r => r.id !== keeper.id)
    await withSlotExclusivityTx(userId, async tx => {
      await tx.rpcConfig.updateMany({
        where: { userId, id: { in: losers.map(r => r.id) } },
        data: { enabled: false },
      })
    })
    const disabledSlots = losers.map(r => (r as { slot?: number }).slot ?? 0)
    rememberHealForUi(userId, disabledSlots)
    return {
      changed: true,
      keepSlot: (keeper as { slot?: number }).slot ?? 1,
      disabledSlots,
      disabledIds: losers.map(r => r.id),
    }
  } catch (e) {
    console.error('enforceRpcSlotExclusivity failed:', e instanceof Error ? e.message : e)
    return idle
  }
}
