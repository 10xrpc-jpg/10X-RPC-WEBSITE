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
  decideGameRotation,
  nextGameSlug,
  parseGameRotateSlots,
  type GameRotateSettings,
  type GameRowLite,
} from './game-rotation'
import { normalizeRotateOrder, normalizeRotateSecs, type RotateOrder } from './rotation'
import { findGame, findGameByName, gamePresetDefaults, GAME_PRESETS } from './games'

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

// ════════════════════════════════════════════════════════════════════════
// SELF-HEAL — duplicate games + pool-row materialization
// ════════════════════════════════════════════════════════════════════════

/** Rewrite the rotation-pool membership for a merged slug pair (raw SQL —
 *  updatedAt, the NORMAL rotation's anchor, stays frozen). */
async function remapGameSlugInRotationState(
  userId: string,
  remap: (slug: string) => string,
): Promise<void> {
  const cfg = await db.globalConfig.findUnique({ where: { userId } })
  if (!cfg) return
  const slots = parseGameRotateSlots(cfg.gameRotateSlots)
  const nextSlots = slots ? Array.from(new Set(slots.map(remap))) : null
  const nextCurrent = cfg.gameRotateCurrent ? remap(cfg.gameRotateCurrent) : null
  const slotsChanged = JSON.stringify(nextSlots) !== JSON.stringify(slots)
  if (!slotsChanged && nextCurrent === cfg.gameRotateCurrent) return
  await db.$executeRaw`
    UPDATE "GlobalConfig"
    SET "gameRotateSlots" = ${nextSlots ? JSON.stringify(nextSlots) : null},
        "gameRotateCurrent" = ${nextCurrent}
    WHERE "userId" = ${userId}`
}

/** Create a default config row for a PRESET game that has no row yet. Used
 *  when the user selects a never-configured catalog game into the rotation
 *  pool — without a row the pool (which is row-based) would silently skip
 *  it. Creating a default row is NOT "modifying a saved configuration" (no
 *  row existed); rotation still never edits existing saved rows. */
export async function materializePresetRows(userId: string, slugs: string[]): Promise<number> {
  let created = 0
  for (const slug of slugs) {
    const preset = findGame(slug)
    if (!preset) continue // custom slugs must own a row already
    const defaults = gamePresetDefaults(slug)
    if (!defaults) continue
    const existing = await db.gameConfig.findUnique({
      where: { userId_gameSlug: { userId, gameSlug: slug } },
      select: { gameSlug: true },
    })
    if (existing) continue
    await db.gameConfig.create({ data: { userId, ...defaults } })
    created++
  }
  return created
}

/**
 * Merge duplicate game rows for one user (self-heal for the historical
 * "Counter-Strike 2 twice" bug — /api/games/custom used to dedupe by appId
 * only, so the official app of a preset game created a second row with the
 * same name). Keeper rules:
 *   • a catalog preset name always maps onto the PRESET slug row;
 *   • among customs, the OLDEST row keeps the name.
 * The duplicate's enabled flag, rotation-pool membership and rotation head
 * pointer are merged onto the keeper, then the duplicate row is deleted.
 * Idempotent and cheap: writes happen only when a duplicate actually exists.
 */
export async function dedupeUserGames(userId: string): Promise<{ changed: boolean; removed: number }> {
  const rows = await db.gameConfig.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  })
  if (rows.length === 0) return { changed: false, removed: 0 }

  const keeperBySlug = new Map<string, string>() // dup slug → keeper slug
  const keeperByNorm = new Map<string, string>() // normalized name → keeper slug
  const toDelete: Array<{ gameSlug: string; enabled: boolean }> = []

  for (const row of rows) {
    const norm = (row.gameName || '').trim().toLowerCase()
    const preset = norm ? findGameByName(row.gameName) : null
    if (preset) {
      if (row.gameSlug === preset.slug) continue // canonical preset row — keeper
      // Custom row duplicating a preset name → the preset slug is the keeper.
      toDelete.push({ gameSlug: row.gameSlug, enabled: row.enabled })
      keeperBySlug.set(row.gameSlug, preset.slug)
      continue
    }
    if (!norm) continue // nameless rows are left alone
    const existingKeeper = keeperByNorm.get(norm)
    if (existingKeeper) {
      toDelete.push({ gameSlug: row.gameSlug, enabled: row.enabled })
      keeperBySlug.set(row.gameSlug, existingKeeper)
    } else {
      keeperByNorm.set(norm, row.gameSlug)
    }
  }
  if (toDelete.length === 0) return { changed: false, removed: 0 }

  // 1) Merge enabled flags onto keepers (before deletion keeps the
  //    single-active window atomic in effect: net enabled set is unchanged).
  for (const dup of toDelete) {
    if (!dup.enabled) continue
    const keeper = keeperBySlug.get(dup.gameSlug)
    if (!keeper) continue
    const keeperRow = await db.gameConfig.findUnique({
      where: { userId_gameSlug: { userId, gameSlug: keeper } },
      select: { gameSlug: true },
    })
    if (keeperRow) {
      await db.gameConfig.update({
        where: { userId_gameSlug: { userId, gameSlug: keeper } },
        data: { enabled: true },
      })
    } else {
      // Keeper is a preset without a row — materialize it ENABLED so the
      // user's live game survives the merge.
      const defaults = gamePresetDefaults(keeper)
      if (defaults) {
        await db.gameConfig.create({ data: { userId, ...defaults, enabled: true } })
      }
    }
  }

  // 2) Rotation state: pool membership + head pointer move to the keeper.
  await remapGameSlugInRotationState(userId, slug => keeperBySlug.get(slug) ?? slug)

  // 3) Delete the duplicates (keeper may be a preset slug — those never get
  //    deleted here because keeper slugs are never in toDelete's keeper set).
  for (const dup of toDelete) {
    await db.gameConfig
      .delete({ where: { userId_gameSlug: { userId, gameSlug: dup.gameSlug } } })
      .catch(() => {})
  }

  return { changed: true, removed: toDelete.length }
}

/**
 * Make the rotation pool REAL: create default rows for every selected preset
 * game that has no row yet (custom slugs are validated by the caller). With
 * slots === null (the canonical "every game rotates") every catalog preset is
 * materialized, so the pool always matches what the UI shows as selected.
 * Never flips any enabled flag — rows are created disabled.
 */
export async function materializePoolRows(userId: string, slots: string[] | null): Promise<void> {
  const wanted = slots ?? GAME_PRESETS.map(p => p.slug)
  if (wanted.length === 0) return
  await materializePresetRows(userId, wanted)
}

/**
 * Re-derive the game-rotation decision RIGHT NOW (the same pure decision the
 * 24/7 daemon runs every tick) and persist it: rotation state (head/anchor/
 * skip watermark) via raw SQL + single-active GameConfig.enabled flags.
 * Used by the website's skip endpoint so a manual "Skip to next game" lands
 * instantly instead of waiting up to one daemon tick (≤10s). Idempotent with
 * the daemon — both sides compute from the same columns and the same pure
 * function, and the skip watermark prevents double-advances.
 * Returns the head the decision seated (null = nothing to run).
 */
export async function reconcileGameRotationNow(userId: string): Promise<string | null> {
  const [cfg, gameRows] = await Promise.all([
    db.globalConfig.findUnique({ where: { userId } }),
    loadGameRows(userId),
  ])
  const view = gameRotateSettingsView(cfg)
  if (!view.enabled) return null
  const decision = decideGameRotation(
    {
      enabled: view.enabled,
      secs: view.secs,
      order: view.order,
      skip: view.skip,
      appliedSkip: Math.max(0, Math.min(1_000_000_000, Math.floor(Number(cfg?.gameRotateAppliedSkip) || 0))),
      slots: view.slots,
      current: view.current,
      anchorMs: view.anchorAt,
    },
    gameRows,
    Date.now(),
  )
  if (decision.stateDirty) {
    await persistGameRotationState(userId, {
      current: decision.current,
      anchorMs: decision.anchorMs,
      appliedSkip: decision.appliedSkip,
    })
  }
  if (decision.flagsDirty && decision.desiredCurrent) {
    await db.gameConfig.updateMany({
      where: { userId, enabled: true, gameSlug: { not: decision.desiredCurrent } },
      data: { enabled: false },
    })
    await db.gameConfig.updateMany({
      where: { userId, gameSlug: decision.desiredCurrent },
      data: { enabled: true },
    })
  }
  return decision.desiredCurrent
}
