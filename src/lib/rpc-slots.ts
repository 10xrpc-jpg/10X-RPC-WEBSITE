// 10X RPC — Multi-RPC slots helpers (max 3 independent RPC configs per user)
// Shared by /api/rpc/slots* routes. The DB is the single source of truth for
// each slot's fields AND its own enabled flag; these helpers only normalize
// slot numbers and serialize rows for the client.

import { db } from '@/lib/db'
import { isGameApplicationId } from '@/lib/games'

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

/** Serialize a slot row for the client (same shape as /api/me rpcConfig). */
export function serializeSlot(cfg: Record<string, unknown> & { slot: number }) {
  return {
    id: cfg.id,
    slot: cfg.slot,
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
