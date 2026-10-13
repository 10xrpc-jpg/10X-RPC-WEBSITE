// 10X RPC — RPC Auto Rotate — deterministic rotation math (PURE module).
//
// ZERO imports — shared VERBATIM by every consumer so the dashboard preview
// ALWAYS matches what the 24/7 daemon actually publishes on Discord:
//   • the 24/7 Orihost daemon (rpc-daemon.ts → resolveRuntimeCandidates)
//   • the website APIs (/api/me rotation preview, /api/rpc/rotate, skip)
//   • the dashboard UI (RpcSlotsManager live "now showing" strip + countdown)
//
// Design invariants (Task 87):
//   • Same inputs → same index on every process / restart / instance
//     (stateless — no daemon-local rotation state anywhere).
//   • Rotation is RUNTIME-ONLY: these functions never read or write configs.
//   • "Skip" advances exactly ONE position from wherever the clock is now,
//     WITHOUT resetting the rotation anchor (raw-SQL counter bump — see
//     /api/rpc/rotate/skip), so skipping never jumps backwards.
//   • "shuffle" remixes the order every FULL cycle but stays deterministic
//     (seeded Fisher–Yates, seed = userId + generation).

export type RotateOrder = 'forward' | 'reverse' | 'shuffle'

export const ROTATE_ORDERS: RotateOrder[] = ['forward', 'reverse', 'shuffle']

/** Clamp bounds for the rotation interval (seconds). The daemon enforces the
 *  same bounds — keep these in sync. */
export const ROTATE_SECS_MIN = 15
export const ROTATE_SECS_MAX = 3600

/** Interval options offered by the dashboard (seconds). */
export const ROTATE_SECS_OPTIONS = [15, 30, 45, 60, 120, 300, 600, 900, 1800] as const

/** Human label for an interval (used by the UI and API messages). */
export function rotateSecsLabel(secs: number): string {
  if (secs < 60) return `${secs} seconds`
  const mins = secs / 60
  return `${mins} minute${mins >= 2 ? 's' : ''}`
}

/** Coerce any input into a valid rotation order (invalid → 'forward'). */
export function normalizeRotateOrder(v: unknown): RotateOrder {
  return ROTATE_ORDERS.includes(v as RotateOrder) ? (v as RotateOrder) : 'forward'
}

/** Coerce any input into a valid rotation interval (invalid → 30). */
export function normalizeRotateSecs(v: unknown): number {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n)) return 30
  return Math.max(ROTATE_SECS_MIN, Math.min(ROTATE_SECS_MAX, n))
}

/** xmur3-style string hash → unsigned 32-bit seed (deterministic everywhere). */
export function hashSeedStr(s: string): number {
  let h = 1779033703 ^ s.length
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return (h ^= h >>> 16) >>> 0
}

/** Deterministic Fisher–Yates shuffle of [0..n-1] driven by an LCG. */
export function seededPermutation(n: number, seed: number): number[] {
  const arr = Array.from({ length: n }, (_, i) => i)
  let s = (seed >>> 0) || 0x9e3779b9 // never zero — LCG degenerates on 0
  const next = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    const tmp = arr[i]
    arr[i] = arr[j]
    arr[j] = tmp
  }
  return arr
}

export interface RotateClockOpts {
  /** Rotation anchor (ms epoch) — GlobalConfig.updatedAt; null → start now. */
  refMs: number | null | undefined
  /** Interval seconds. */
  secs: number
  /** Manual advance counter (Skip Now). */
  skip?: number | null
  nowMs?: number
}

/** The rotation "cycle" counter — how many intervals elapsed since the anchor
 *  plus the manual skip count. Monotonic; the index derives from it. */
export function rotateCycleCount(opts: RotateClockOpts): number {
  const secs = normalizeRotateSecs(opts.secs)
  const nowMs = opts.nowMs ?? Date.now()
  const ref = opts.refMs && Number.isFinite(opts.refMs) && opts.refMs <= nowMs ? opts.refMs : nowMs
  const elapsedSecs = Math.max(0, Math.floor((nowMs - ref) / 1000))
  const skip = Math.max(0, Math.floor(Number(opts.skip) || 0))
  return Math.floor(elapsedSecs / secs) + skip
}

export interface RotateIndexOpts extends RotateClockOpts {
  order?: RotateOrder | string | null
  /** Length of the rotation pool (≥1). */
  length: number
  /** Shuffle seed (userId). Deterministic per user + generation. */
  seed?: string | null
}

/**
 * The 0-based pool index being published RIGHT NOW.
 *   forward : cycle % n
 *   reverse : (n-1 - cycle) % n
 *   shuffle : perm[generation(cycle)] [ cycle % n ] — remixes every full cycle
 */
export function rotateCycleIndex(opts: RotateIndexOpts): number {
  const n = Math.max(1, Math.floor(Number(opts.length) || 1))
  const cycle = Math.max(0, rotateCycleCount(opts))
  const pos = ((cycle % n) + n) % n
  const order = normalizeRotateOrder(opts.order)
  if (order === 'reverse') return (n - 1 - pos) % n
  if (order === 'shuffle') {
    const generation = Math.floor(cycle / n)
    const perm = seededPermutation(n, hashSeedStr(`${opts.seed ?? ''}:${generation}`))
    return perm[pos] ?? pos
  }
  return pos
}

/** Seconds until the NEXT rotation switch fires (for countdowns). */
export function rotateNextSwitchInSecs(opts: RotateClockOpts): number {
  const secs = normalizeRotateSecs(opts.secs)
  const nowMs = opts.nowMs ?? Date.now()
  const ref = opts.refMs && Number.isFinite(opts.refMs) && opts.refMs <= nowMs ? opts.refMs : nowMs
  const elapsedSecs = Math.max(0, Math.floor((nowMs - ref) / 1000))
  return secs - (elapsedSecs % secs)
}
