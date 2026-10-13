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
}

export type GlobalConfigRotateRow = {
  rpcAutoRotate?: boolean | null
  rpcRotateSecs?: number | null
  rpcRotateOrder?: string | null
  rpcRotateIncludeGame?: boolean | null
  rpcRotateSkip?: number | null
  updatedAt?: Date | string | null
} | null

export function rotateSettingsView(row: GlobalConfigRotateRow): RotateSettingsView {
  return {
    enabled: !!row?.rpcAutoRotate,
    secs: normalizeRotateSecs(row?.rpcRotateSecs ?? 30),
    order: normalizeRotateOrder(row?.rpcRotateOrder),
    includeGame: row?.rpcRotateIncludeGame !== false,
    skip: Math.max(0, Math.min(1_000_000_000, Math.floor(Number(row?.rpcRotateSkip) || 0))),
    refMs: row?.updatedAt ? new Date(row.updatedAt).getTime() : null,
  }
}
