// 10X RPC — server-side input caps shared by config-saving endpoints.
// Purpose: bound storage size and keep values within Discord's presence
// limits (state/details/texts ≤ 128 chars etc.). These are tolerant caps —
// they never reject a request, they clamp the value that gets persisted.

export function capStr(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const trimmed = v.trim()
  if (!trimmed) return null
  return trimmed.slice(0, max)
}

export function capNum(v: unknown, min: number, max: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return Math.min(max, Math.max(min, Math.round(v)))
}

// Discord presence text fields (state / details / large_text / small_text).
export const LIMIT_TEXT = 128
// Asset references: asset keys, asset IDs, mp:external paths, or image URLs.
export const LIMIT_ASSET_REF = 1024
// External URLs (buttons, user backgrounds).
export const LIMIT_URL = 2048
// Button labels / short names.
export const LIMIT_SHORT = 64
