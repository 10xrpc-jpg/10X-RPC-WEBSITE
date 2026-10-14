// 10X RPC — Game Auto-Rotate settings view + server helpers (Task 95).
// Mirrors rpc-rotate-settings.ts for the GAME rotation system. This module is
// the SINGLE server-side place that turns GlobalConfig gameRotate* columns
// into the canonical view shape shared by /api/games/rotate,
// /api/games/rotate/skip and /api/games/[slug] — so every response carries
// identical fields.
//
// WRITE RULE: every gameRotate* write goes through raw SQL that NEVER touches
// GlobalConfig.updatedAt. updatedAt is the NORMAL rotation's clock anchor —
// a regular Prisma update here would silently reset the Normal RPC rotation
// phase (cross-system interference, forbidden by the Task 95 spec).
import { db } from './db'
import {
  buildGamePool,
  nextGameSlug,
  parseGameRotateSlots,
  type GameRotateSettings,
  type GameRowLite,
} from './game-rotation'
import { normalizeRotateOrder, normalizeRotateSecs, type RotateOrder } from './rotation'

export interface GameRotateSettingsView {
  enabled: boolean
  secs: number
  order: RotateOrder
  /** Manual advance counter ("Skip to next game"). */
  skip: number
  /** Selected rotation pool (game slugs). null = every game. */
  slots: string[] | null
  /** Slug currently published by the rotation. */
  current: string | null
  /** Clock anchor (ms epoch). */
  anchorAt: number | null
}

export type GlobalConfigGameRotateRow = {
  gameRotateEnabled?: boolean | null
  gameRotateSecs?: number | null
  gameRotateOrder?: string | null
  gameRotateSkip?: number | null
  gameRotateSlots?: string | null
  gameRotateCurrent?: string | null
  gameRotateAnchorAt?: Date | string | null
} | null

export function gameRotateSettingsView(row: GlobalConfigGameRotateRow): GameRotateSettingsView {
  return {
    enabled: !!row?.gameRotateEnabled,
    secs: normalizeRotateSecs(row?.gameRotateSecs ?? 60),
    order: normalizeRotateOrder(row?.gameRotateOrder),
    skip: Math.max(0, Math.min(1_000_000_000, Math.floor(Number(row?.gameRotateSkip) || 0))),
    slots: parseGameRotateSlots(row?.gameRotateSlots),
    current: typeof row?.gameRotateCurrent === 'string' && row.gameRotateCurrent ? row.gameRotateCurrent : null,
    anchorAt: row?.gameRotateAnchorAt ? new Date(row.gameRotateAnchorAt).getTime() : null,
  }
}

/** Raw-SQL write of the rotation STATE columns (current/anchor/appliedSkip).
 *  Never touches updatedAt. Creates the GlobalConfig row if missing. */
export async function persistGameRotationState(
  userId: string,
  state: { current: string | null; anchorMs: number | null; appliedSkip: number },
): Promise<void> {
  const updated = await db.$executeRaw`
    UPDATE "GlobalConfig"
    SET "gameRotateCurrent" = ${state.current},
        "gameRotateAnchorAt" = ${state.anchorMs !== null && Number.isFinite(state.anchorMs) ? new Date(state.anchorMs) : null},
        "gameRotateAppliedSkip" = ${Math.max(0, Math.min(1_000_000_000, Math.floor(state.appliedSkip) || 0))}
    WHERE "userId" = ${userId}`
  if (updated === 0) {
    await db.globalConfig.create({ data: { userId } })
    await db.$executeRaw`
      UPDATE "GlobalConfig"
      SET "gameRotateCurrent" = ${state.current},
          "gameRotateAnchorAt" = ${state.anchorMs !== null && Number.isFinite(state.anchorMs) ? new Date(state.anchorMs) : null},
          "gameRotateAppliedSkip" = ${Math.max(0, Math.min(1_000_000_000, Math.floor(state.appliedSkip) || 0))}
      WHERE "userId" = ${userId}`
  }
}

/** Read the user's games as the pure lib's GameRowLite shape (createdAt asc). */
export async function loadGameRows(userId: string): Promise<GameRowLite[]> {
  const rows = await db.gameConfig.findMany({
    where: { userId },
    select: { gameSlug: true, enabled: true, createdAt: true },
  })
  return rows.map(r => ({
    gameSlug: r.gameSlug,
    enabled: r.enabled,
    createdAtMs: new Date(r.createdAt).getTime(),
  }))
}

/**
 * Advance the rotation by ONE step from `fromSlug` (or re-seat the pool head
 * when fromSlug is null/invalid) and make it the SINGLE enabled game:
 *   • pool = selected slugs ∩ existing rows (null selection → every game)
 *   • persist current + anchor=now via raw SQL (updatedAt untouched)
 *   • flip GameConfig.enabled so exactly the new current is enabled
 * Returns the new current slug (null = empty pool — nothing to enable).
 * Used by the manual paths: enabling a game (manual takeover), disabling the
 * active game while rotation is ON (= "advance to next selected game") and
 * deleting the active custom game.
 */
export async function advanceGameRotation(
  userId: string,
  fromSlug: string | null,
  seed: string,
): Promise<string | null> {
  const [cfg, gameRows] = await Promise.all([
    db.globalConfig.findUnique({ where: { userId } }),
    loadGameRows(userId),
  ])
  const view = gameRotateSettingsView(cfg)
  if (!view.enabled) return null // rotation governs nothing while OFF

  const pool = buildGamePool(gameRows, view.slots)
  const next = nextGameSlug(pool, fromSlug, view.order, seed)
  if (!next) return null

  await persistGameRotationState(userId, {
    current: next,
    anchorMs: Date.now(),
    appliedSkip: Math.max(0, Math.min(1_000_000_000, Number(cfg?.gameRotateSkip) || 0)),
  })

  // Single-active flag flip — exactly ONE game stays enabled.
  await db.gameConfig.updateMany({
    where: { userId, enabled: true, gameSlug: { not: next } },
    data: { enabled: false },
  })
  await db.gameConfig.updateMany({
    where: { userId, gameSlug: next },
    data: { enabled: true },
  })
  return next
}

/** Manual takeover: the user explicitly enabled `slug` — remember it as the
 *  rotation head. Written even while rotation is OFF (benign pointer write —
 *  it remembers the user's last manual choice so turning rotation ON later
 *  continues from THAT game). Never touches Normal RPC rotation state. */
export async function takeOverGameRotation(userId: string, slug: string): Promise<void> {
  const cfg = await db.globalConfig.findUnique({
    where: { userId },
    select: { gameRotateAppliedSkip: true },
  }).catch(() => null)
  await persistGameRotationState(userId, {
    current: slug,
    anchorMs: Date.now(),
    appliedSkip: Math.max(0, Math.min(1_000_000_000, Number(cfg?.gameRotateAppliedSkip) || 0)),
  })
}

/** Convert the stored settings into the pure lib's input shape. */
export function toLibSettings(view: GameRotateSettingsView): GameRotateSettings {
  return {
    enabled: view.enabled,
    secs: view.secs,
    order: view.order,
    skip: view.skip,
    appliedSkip: 0, // website callers don't need the watermark
    slots: view.slots,
    current: view.current,
    anchorMs: view.anchorAt,
  }
}
