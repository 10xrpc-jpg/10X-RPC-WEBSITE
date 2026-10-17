// 10X RPC — Auto-Rotate RPC LIFECYCLE (Task 113)
//
// The Auto Rotator now OWNS the RPC slot lifecycle end-to-end: while it is ON
// exactly ONE eligible (configured) pool member carries enabled=true — the one
// whose turn it is — and every other POOL member carries enabled=false. The
// switches the user sees, the database rows, and the presence published on
// Discord all describe the same live RPC at every moment.
//
// Shared by (ZERO duplication of the pool/index rules):
//   • the 24/7 daemon  (rpc-daemon.ts → per-tick reconcile — keeps flipping
//     the flags at every rotation boundary, ≤10s, plus the precision tick)
//   • the website APIs (rotate save / rotate skip / slot toggle — apply the
//     flags INSTANTLY on every user action so the DB/UI never go stale)
//   • unit/integration tests
//
// Design invariants:
//   • The rotation CLOCK stays the shared stateless math in rotation.ts
//     (anchor = GlobalConfig.updatedAt + skip counter) — the website preview,
//     the daemon presence and this flag reconcile all derive the SAME current
//     member from the SAME inputs. No new state columns.
//   • Eligibility = CONFIGURED rows only (visibleRpcRows). Unconfigured
//     placeholder rows are never pool members and never touched (requirement:
//     "skip unconfigured or invalid RPCs without breaking the rotation").
//   • Only the `enabled` flag is written. Saved RPC content (name, type,
//     device, images, buttons, timestamps...) is 100% read-only to rotation.
//   • Non-pool enabled slots (the user left an enabled RPC OUT of the
//     selection) are never touched by the reconcile, and the rotator must not
//     create a second enabled slot while one of them runs (the app-wide
//     one-active-slot rule, Task 108, stays intact).
//   • Rotation OFF → this module never writes anything (requirement 10).

import { db } from './db'
import { rotateCycleIndex, rotateNextSwitchInSecs, type RotateOrder } from './rotation'

/** Minimal slot row the decisions need (daemon rows / API rows / tests). */
export interface RpcRotationSlotLite {
  id: string
  enabled: boolean
  createdAtMs: number
}

/** Canonical rotation settings (mirrors fetchRpcRotateSettings / rotateSettingsView). */
export interface RpcRotationSettingsLite {
  enabled: boolean
  secs: number
  order: RotateOrder | string | null
  skip: number
  /** Clock anchor (ms epoch) — GlobalConfig.updatedAt. */
  refMs: number | null
  /** Explicit pool selection (RpcConfig ids). null = every configured slot. */
  slots: string[] | null
  /** Shuffle seed — the userId. */
  seed: string
}

/**
 * The rotation POOL — every eligible slot id in deterministic order.
 *
 *   • `explicitKeys` set & non-empty → exactly those slots (unknown/stale ids
 *     dropped); when the selection matches NOTHING (deleted slots) it falls
 *     back to ALL configured slots so the profile never goes blank.
 *   • `explicitKeys` null/empty → EVERY configured slot rotates (requirement 1:
 *     Auto-Rotate supports every configured RPC — enabled or not — and
 *     requirement 2: it must run even when all switches start OFF).
 *
 * `allSlots` MUST already be filtered to configured rows (visibleRpcRows).
 * Order preservation is the caller's concern (pass slot order).
 */
export function buildRpcRotationPool(
  allSlots: RpcRotationSlotLite[],
  explicitKeys: string[] | null | undefined,
): string[] {
  const ids = allSlots.map(s => s.id).filter(id => typeof id === 'string' && id.length > 0)
  const keys = Array.isArray(explicitKeys)
    ? explicitKeys.filter((k): k is string => typeof k === 'string' && k.length > 0)
    : null
  if (!keys || keys.length === 0) return ids
  const set = new Set(keys)
  const picked = ids.filter(id => set.has(id))
  return picked.length > 0 ? picked : ids
}

/**
 * ONE decision: which pool member should be enabled RIGHT NOW?
 * Pure — same inputs as the daemon presence resolver (rotation.ts clock) so
 * the enabled flag, the UI strip and Discord always agree.
 * Returns null currentId when rotation is OFF, the pool is empty, or the
 * master gate is closed (caller passes enabled=false in that case).
 */
export function decideRpcRotationFlags(
  s: RpcRotationSettingsLite,
  allSlots: RpcRotationSlotLite[],
  nowMs: number,
): { poolIds: string[]; currentId: string | null; nextSwitchInSecs: number | null } {
  if (!s.enabled) return { poolIds: [], currentId: null, nextSwitchInSecs: null }
  const poolIds = buildRpcRotationPool(allSlots, s.slots)
  if (poolIds.length === 0) return { poolIds: [], currentId: null, nextSwitchInSecs: null }
  const idx = rotateCycleIndex({
    refMs: s.refMs,
    secs: s.secs,
    skip: s.skip,
    order: s.order,
    length: poolIds.length,
    seed: s.seed,
    nowMs,
  })
  const nextSwitchInSecs = rotateNextSwitchInSecs({ refMs: s.refMs, secs: s.secs, nowMs })
  return { poolIds, currentId: poolIds[idx] ?? null, nextSwitchInSecs }
}

/**
 * Persist the desired lifecycle state for one user:
 *   1. every enabled POOL member except `currentId` → enabled=false
 *      (requirement 4: disable the previous RPC before/when the next one
 *      activates — never two at once),
 *   2. `currentId` → enabled=true, BUT only while no NON-pool slot is enabled
 *      (an enabled slot the user left out of the rotation keeps running; the
 *      one-active-slot invariant must never be broken by the rotator).
 *
 * Writes ONLY the enabled flag. Returns whether anything changed plus the
 * AUTHORITATIVE enabled-id set after the apply (so callers can mirror the
 * exact DB state in memory without a re-read).
 */
export async function applyRpcRotationFlags(
  userId: string,
  poolIds: string[],
  currentId: string | null,
): Promise<{ changed: boolean; enabledIds: string[] }> {
  try {
    let changed = false

    // 1. Disable every other POOL member that is currently enabled.
    const disableIds = poolIds.filter(id => id && id !== currentId)
    if (disableIds.length > 0) {
      const off = await db.rpcConfig.updateMany({
        where: { userId, enabled: true, id: { in: disableIds } },
        data: { enabled: false },
      })
      changed = changed || off.count > 0
    }

    // 2. Enable the current member — never alongside a non-pool enabled slot.
    let currentEnabled = false
    let nonPoolIds: string[] = []
    if (currentId && poolIds.includes(currentId)) {
      const nonPoolEnabled = await db.rpcConfig.findMany({
        where: { userId, enabled: true, id: { notIn: poolIds } },
        select: { id: true },
      })
      nonPoolIds = nonPoolEnabled.map(r => r.id)
      if (nonPoolEnabled.length === 0) {
        const on = await db.rpcConfig.updateMany({
          where: { userId, id: currentId, enabled: false },
          data: { enabled: true },
        })
        changed = changed || on.count > 0
        currentEnabled = true
      }
    }

    return {
      changed,
      enabledIds: [...nonPoolIds, ...(currentEnabled && currentId ? [currentId] : [])],
    }
  } catch (e) {
    console.warn(`[rpc-rotation-lifecycle] applyRpcRotationFlags failed for ${userId}:`,
      e instanceof Error ? e.message : e)
    return { changed: false, enabledIds: [] }
  }
}

/**
 * Full per-user reconcile — decide + apply. Used by the daemon tick AND the
 * website APIs (save / skip / toggle) so every path lands the SAME lifecycle
 * state from the SAME inputs.
 *
 * `allSlots` must be the user's CONFIGURED slot rows (visibleRpcRows), in
 * slot order, WITH their live enabled flags. `masterOn` = session.rpcEnabled.
 * Returns the decision + whether flags changed + the authoritative enabled-id
 * set after the apply + seconds to the next switch (null when rotation is
 * idle — no precision tick needed).
 */
export async function reconcileRpcRotationFlags(
  userId: string,
  s: RpcRotationSettingsLite,
  allSlots: RpcRotationSlotLite[],
  nowMs: number,
  masterOn: boolean,
): Promise<{
  poolIds: string[]
  currentId: string | null
  changed: boolean
  enabledIds: string[]
  nextSwitchInSecs: number | null
}> {
  const effective: RpcRotationSettingsLite = masterOn ? s : { ...s, enabled: false }
  const decision = decideRpcRotationFlags(effective, allSlots, nowMs)
  if (!decision.currentId) {
    // Rotation idle — requirement 10: never write anything while it is off
    // (and nothing to rotate → leave every switch exactly as the user set it).
    return { ...decision, changed: false, enabledIds: allSlots.filter(r => r.enabled).map(r => r.id), nextSwitchInSecs: null }
  }
  const applied = await applyRpcRotationFlags(userId, decision.poolIds, decision.currentId)
  return { ...decision, ...applied, nextSwitchInSecs: decision.nextSwitchInSecs }
}
