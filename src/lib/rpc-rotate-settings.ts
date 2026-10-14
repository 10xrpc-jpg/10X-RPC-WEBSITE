// 10X RPC — Auto Rotate settings view helper (server-side).
// Single place that turns a GlobalConfig row into the canonical rotation
// settings shape shared by /api/me, /api/rpc/rotate, /api/rpc/rotate/skip,
// /api/rpc/slots — so every response carries identical fields.
import { normalizeRotateOrder, normalizeRotateSecs, type RotateOrder } from './rotation'

export interface RotateSettingsView {
  enabled: boolean
  secs: number
  order: RotateOrder
  includeGame: boolean
  /** Manual advance counter ("Skip to next RPC"). */
  skip: number
  /** Rotation clock anchor (GlobalConfig.updatedAt, ms epoch). */
  refMs: number | null
  /**
   * Task 89 — explicit rotation pool (candidate keys: RpcConfig ids or
   * "game:<slug>"). null = not set → every enabled RPC rotates per the
   * legacy includeGame rule; an array = ONLY those candidates rotate.
   */
  slots: string[] | null
}

export type GlobalConfigRotateRow = {
  rpcAutoRotate?: boolean | null
  rpcRotateSecs?: number | null
  rpcRotateOrder?: string | null
  rpcRotateIncludeGame?: boolean | null
  rpcRotateSkip?: number | null
  /** Task 89 — JSON string[] of candidate keys (raw column). */
  rpcRotateSlots?: string | null
  updatedAt?: Date | string | null
} | null

/** Parse the stored rpcRotateSlots JSON column (safe — null on any problem). */
function parseRotateSlots(raw: string | null | undefined): string[] | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    const out: string[] = []
    for (const v of parsed) {
      if (typeof v !== 'string') continue
      const k = v.slice(0, 64)
      if (k && !out.includes(k)) out.push(k)
      if (out.length >= 12) break
    }
    return out
  } catch {
    return null
  }
}

export function rotateSettingsView(row: GlobalConfigRotateRow): RotateSettingsView {
  return {
    enabled: !!row?.rpcAutoRotate,
    secs: normalizeRotateSecs(row?.rpcRotateSecs ?? 30),
    order: normalizeRotateOrder(row?.rpcRotateOrder),
    includeGame: row?.rpcRotateIncludeGame !== false,
    skip: Math.max(0, Math.min(1_000_000_000, Math.floor(Number(row?.rpcRotateSkip) || 0))),
    refMs: row?.updatedAt ? new Date(row.updatedAt).getTime() : null,
    slots: parseRotateSlots(row?.rpcRotateSlots),
  }
}
