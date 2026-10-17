// 10X RPC — GAME Auto-Rotate — pure decision logic (Task 95).
//
// ZERO I/O, ZERO database access. Shared by:
//   • the 24/7 daemon (rpc-daemon.ts → reconcileGameRotation — raw-SQL
//     persistence of the decision)
//   • the website APIs (/api/games/rotate, /api/games/[slug] single-active +
//     advance-on-disable)
//   • unit tests (scripts/tmp/t95-*.mts)
//
// INDEPENDENCE GUARANTEE (Task 95 spec §2/§3): this module never reads or
// writes ANY Normal-RPC rotation state (rpcAutoRotate*, RotatorPreset,
// rotation.ts clock math is reused as a pure helper only) and the Normal
// rotation path (resolveRuntimeCandidates / rotationPoolCandidates) never
// reads game-rotation state. The two systems share NO timers, NO anchors and
// NO columns — Game rotation lives in gameRotate* GlobalConfig columns and
// GameConfig.enabled only.

import {
  normalizeRotateOrder,
  normalizeRotateSecs,
  hashSeedStr,
  seededPermutation,
  type RotateOrder,
} from './rotation'

/** Canonical shape of the game-rotation settings (from GlobalConfig). */
export interface GameRotateSettings {
  enabled: boolean
  /** Interval seconds (15..3600). */
  secs: number
  order: RotateOrder
  /** Manual skip counter ("Skip to next game") — raw-SQL bumped. */
  skip: number
  /** Watermark: the skip counter the daemon has already applied. */
  appliedSkip: number
  /** Selected pool (game slugs). null = not set → every game rotates. */
  slots: string[] | null
  /** Slug currently published by the rotation (persists restarts). */
  current: string | null
  /** Clock anchor (ms epoch). null → the daemon starts the clock now. */
  anchorMs: number | null
}

export const GAME_ROTATE_DEFAULTS: GameRotateSettings = {
  enabled: false,
  secs: 60,
  order: 'forward',
  skip: 0,
  appliedSkip: 0,
  slots: null,
  current: null,
  anchorMs: null,
}

/** Minimal game row the decisions need (daemon rows / API rows / tests). */
export interface GameRowLite {
  gameSlug: string
  enabled: boolean
  createdAtMs: number
}

export interface GameRotationDecision {
  /** The ONE game that should be enabled after this decision (null = none). */
  desiredCurrent: string | null
  /** Rotation-state fields to persist when stateDirty. */
  current: string | null
  anchorMs: number | null
  appliedSkip: number
  /** Rotation state changed → persist current/anchor/appliedSkip. */
  stateDirty: boolean
  /** The enabled-flag set must be rewritten to { desiredCurrent }. */
  flagsDirty: boolean
}

/** Parse the stored gameRotateSlots JSON column (safe — null on any problem).
 *  Slugs are validated downstream against real GameConfig rows. */
export function parseGameRotateSlots(raw: unknown): string[] | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    const out: string[] = []
    for (const v of parsed) {
      if (typeof v !== 'string') continue
      const k = v.trim().slice(0, 96)
      if (k && !out.includes(k)) out.push(k)
      if (out.length >= 24) break
    }
    return out
  } catch {
    return null
  }
}

/**
 * The effective rotation pool: the user's selected games (ordered by row
 * creation time — stable across processes), filtered to games that actually
 * exist. `slots: null` → every game rotates. An explicit selection that
 * matches nothing falls back to every game (never blank the profile).
 */
export function buildGamePool(allGames: GameRowLite[], slots: string[] | null): string[] {
  const ordered = [...allGames]
    .sort((a, b) => a.createdAtMs - b.createdAtMs)
    .map(g => g.gameSlug)
  if (!Array.isArray(slots)) return ordered
  const set = new Set(slots)
  const pool = ordered.filter(slug => set.has(slug))
  return pool.length > 0 ? pool : ordered
}

/**
 * The NEXT game after `current` (deterministic). `current` missing from the
 * pool (manual takeover of a non-pool game, or null) starts the walk:
 *   forward  → pool[0]
 *   reverse  → pool[len-1]
 *   shuffle  → first perm entry ≠ current (seeded, stable per current+pool)
 */
export function nextGameSlug(
  pool: string[],
  current: string | null,
  order: RotateOrder | string | null,
  seed: string,
): string | null {
  if (pool.length === 0) return null
  if (pool.length === 1) return pool[0]
  const o = normalizeRotateOrder(order)
  const idx = current ? pool.indexOf(current) : -1
  if (o === 'reverse') {
    return idx <= -1 ? pool[pool.length - 1] : pool[(idx - 1 + pool.length) % pool.length]
  }
  if (o === 'shuffle') {
    const perm = seededPermutation(pool.length, hashSeedStr(`${seed}:${current ?? ''}:${pool.length}`))
    for (const p of perm) {
      const slug = pool[p]
      if (slug && slug !== current) return slug
    }
    return pool[0]
  }
  return pool[(idx + 1) % pool.length]
}

/**
 * ONE decision per tick: what should the game-rotation state and the
 * GameConfig.enabled flags look like right now?
 *
 * Rotation OFF → never rotate; only enforce the single-active invariant
 * (legacy multi-enabled states collapse to the most recently enabled game —
 * the one the user turned on last).
 *
 * Rotation ON → exactly one game from the pool is enabled at all times:
 *   • pending manual skips apply immediately (anchor resets)
 *   • an invalid/missing current re-seats to the pool head
 *   • a missing anchor starts the clock now
 *   • an elapsed interval advances ONE step (no burst catch-up after downtime)
 */
export function decideGameRotation(
  s: GameRotateSettings,
  allGames: GameRowLite[],
  nowMs: number,
): GameRotationDecision {
  const enabledSlugs = allGames.filter(g => g.enabled).map(g => g.gameSlug)
  const currentValid = !!s.current && allGames.some(g => g.gameSlug === s.current)

  if (!s.enabled) {
    if (enabledSlugs.length > 1) {
      // Single-active invariant — keep the most recently enabled game.
      const latest = [...allGames]
        .filter(g => g.enabled)
        .sort((a, b) => b.createdAtMs - a.createdAtMs)[0]
      return {
        desiredCurrent: latest?.gameSlug ?? null,
        current: s.current,
        anchorMs: s.anchorMs,
        appliedSkip: s.appliedSkip,
        stateDirty: false,
        flagsDirty: true,
      }
    }
    return {
      desiredCurrent: enabledSlugs[0] ?? null,
      current: s.current,
      anchorMs: s.anchorMs,
      appliedSkip: s.appliedSkip,
      stateDirty: false,
      flagsDirty: false,
    }
  }

  // ── Rotation ON ─────────────────────────────────────────────────────────
  const pool = buildGamePool(allGames, s.slots ?? null)
  const secs = normalizeRotateSecs(s.secs)

  // Nothing to rotate — never touch flags, never enable anything.
  if (pool.length === 0) {
    return {
      desiredCurrent: currentValid ? s.current : null,
      current: s.current,
      anchorMs: s.anchorMs,
      appliedSkip: s.appliedSkip,
      stateDirty: false,
      flagsDirty: false,
    }
  }

  let current = currentValid ? (s.current as string) : null
  let anchorMs = s.anchorMs
  let appliedSkip = s.appliedSkip
  let stateDirty = false

  // 1) Pending manual skips win — advance exactly (skip − appliedSkip) steps.
  const pendingSkips = Math.max(0, Math.min(1000, s.skip - s.appliedSkip))
  if (pendingSkips > 0) {
    for (let i = 0; i < pendingSkips; i++) {
      current = nextGameSlug(pool, current, s.order, /* seed */ 'game-rotate')
    }
    appliedSkip = s.appliedSkip + pendingSkips
    anchorMs = nowMs
    stateDirty = true
  } else if (!current) {
    // 2) No valid current (first run / current deleted) — seat the pool head.
    current = pool[0]
    anchorMs = nowMs
    stateDirty = true
  } else if (!pool.includes(current)) {
    // 3) Current exists but the user excluded it from the rotation pool (or
    //    it was manually enabled while OFF) — advance INTO the pool now so
    //    rotation only ever publishes pool games (never a full interval of
    //    an excluded game).
    current = nextGameSlug(pool, current, s.order, 'game-rotate')
    anchorMs = nowMs
    stateDirty = true
  } else if (!anchorMs || !Number.isFinite(anchorMs) || anchorMs > nowMs) {
    // 4) No anchor (or clock skew) — start the interval from now.
    anchorMs = nowMs
    stateDirty = true
  } else if (nowMs - anchorMs >= secs * 1000) {
    // 5) Interval elapsed — advance ONE step (never burst-catch-up).
    current = nextGameSlug(pool, current, s.order, 'game-rotate')
    anchorMs = nowMs
    stateDirty = true
  }

  const flagsDirty = current !== null &&
    !(enabledSlugs.length === 1 && enabledSlugs[0] === current)

  return {
    desiredCurrent: current,
    current,
    anchorMs,
    appliedSkip,
    stateDirty,
    flagsDirty,
  }
}
