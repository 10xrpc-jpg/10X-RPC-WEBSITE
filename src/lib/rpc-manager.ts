// 10X RPC — Real Discord RPC Manager
// Connects to Discord's Gaming SDK gateway, identifies with the user's OAuth token,
// and sends PRESENCE_UPDATE (op-3) to set the user's rich presence activity and custom status.

import WebSocket from 'ws'
import { CONFIG } from './config'
import type { RpcConfig } from './api-client'
import type { PlaceholderContext } from './placeholders'
import { resolvePlaceholders } from './placeholders'
import { resolveRpcActivityName } from './constants'
import { GAME_SPOOF, findGame, DISCORD_APP_ID_RE, isGameApplicationId, type GameSpoofEntry } from './games'
import { resolveAssetRef, resolveExternalAsset, sanitizeActivities, type ResolveOpts } from './discord-assets'
import { discordAuthValue } from './discord-auth'
import { buildIdentify } from './gateway-platform'
import { rotateCycleIndex, normalizeRotateOrder, type RotateOrder } from './rotation'

export type { RotateOrder }

export type { ResolveOpts }

/**
 * Custom games ("Add Games") store an optional Discord Application ID on the
 * GameConfig row. The Orihost daemon runs a Prisma client generated BEFORE the
 * appId column existed, so the value is read via $queryRaw (schema-independent
 * for both the Vercel in-process daemon and the standalone Orihost daemon).
 * Returns null for preset slugs, missing/invalid ids, or DB errors.
 */
export async function fetchGameAppId(userId: string, gameSlug: string | null | undefined): Promise<string | null> {
  if (!gameSlug || !gameSlug.startsWith('custom-')) return null
  try {
    const { db } = await import('./db')
    const rows = await db.$queryRaw<Array<{ appId: string | null }>>`
      SELECT "appId" FROM "GameConfig"
      WHERE "userId" = ${userId} AND "gameSlug" = ${gameSlug}
      LIMIT 1`
    const id = rows?.[0]?.appId ?? null
    return id && DISCORD_APP_ID_RE.test(id) ? id : null
  } catch {
    return null
  }
}

/**
 * The Normal RPC config's user-supplied Discord Application ID ("Application
 * ID" field on the Rich Presence form), read via $queryRaw so this works on
 * EVERY Prisma client generation — including the Orihost standalone daemon,
 * whose client may predate the RpcConfig.appId column (same reasoning as
 * fetchGameAppId above). Returns null when unset/invalid/DB error.
 */
export async function fetchRpcAppId(userId: string): Promise<string | null> {
  try {
    const { db } = await import('./db')
    const rows = await db.$queryRaw<Array<{ appId: string | null }>>`
      SELECT "appId" FROM "RpcConfig"
      WHERE "userId" = ${userId}
      ORDER BY "updatedAt" DESC
      LIMIT 1`
    const id = rows?.[0]?.appId ?? null
    return id && DISCORD_APP_ID_RE.test(id) ? id : null
  } catch {
    return null
  }
}

/**
 * Per-row Application IDs for EVERY RpcConfig row of a user (multi-slot).
 * Multi-RPC: each slot carries its OWN "Application ID" — the daemon reads
 * the full id→appId map so every candidate activity can run as its own
 * application. $queryRaw keeps this working on Prisma clients generated
 * before the RpcConfig.appId column existed (standalone Orihost daemon).
 */
export async function fetchRpcAppIds(userId: string): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  try {
    const { db } = await import('./db')
    const rows = await db.$queryRaw<Array<{ id: string; appId: string | null }>>`
      SELECT "id", "appId" FROM "RpcConfig"
      WHERE "userId" = ${userId}`
    for (const r of rows ?? []) {
      // Normal slots never present under a game's application id — a game id
      // stored on a slot row is a legacy/bad row → treat as unset.
      if (r.appId && DISCORD_APP_ID_RE.test(r.appId) && !isGameApplicationId(r.appId)) map.set(r.id, r.appId)
    }
  } catch {
    // DB error / missing column on a very old client — empty map, per-row
    // cfg.appId (fresh client) still takes precedence downstream.
  }
  return map
}

// Activity types mapped to Discord's numeric values
export const ACTIVITY_TYPE_MAP: Record<string, number> = {
  PLAYING: 0,
  STREAMING: 1,
  LISTENING: 2,
  WATCHING: 3,
  CUSTOM: 4,
  COMPETING: 5,
}

export interface PresenceResult {
  ok: boolean
  method: 'gateway' | 'rest' | 'none'
  message: string
  activities?: object[]
  activity?: object
}

/**
 * Build a Discord activity payload from the user's RPC config.
 * Resolves dynamic placeholders in state/details using the placeholder engine.
 */
export async function buildActivityPayload(
  cfg: RpcConfig,
  placeholderCtx: PlaceholderContext,
  assetOpts?: ResolveOpts
): Promise<object> {
  const state = await resolvePlaceholders(cfg.state || '', placeholderCtx)
  const details = await resolvePlaceholders(cfg.details || '', placeholderCtx)
  const type = ACTIVITY_TYPE_MAP[cfg.type || 'PLAYING'] ?? 0
  const activityName = resolveRpcActivityName(cfg.name, cfg.platform)

  const activity: Record<string, unknown> = {
    type,
    name: activityName,
  }

  if (state) activity.state = state
  if (details) activity.details = details

  // URLs
  if ((cfg as any).url) activity.url = (cfg as any).url

  // Timestamps — Discord Gateway OP 3 expects Unix time in MILLISECONDS (not seconds)
  const now = Date.now()
  const rawUpdated = (cfg as any).updatedAt
  const baseTime = rawUpdated
    ? new Date(rawUpdated).getTime()
    : (placeholderCtx?.rpcStartedAt && !isNaN(placeholderCtx.rpcStartedAt) ? placeholderCtx.rpcStartedAt : now)
  const safeBase = (!isNaN(baseTime) && baseTime <= now) ? Math.floor(baseTime) : now

  if (cfg.startMinsAgo != null && cfg.startMinsAgo >= 0) {
    const startMs = Math.floor(safeBase - (cfg.startMinsAgo * 60 * 1000))
    activity.timestamps = {
      start: startMs,
    }
  }
  if (cfg.endTotalMins != null && cfg.endTotalMins > 0) {
    const startMs = (activity.timestamps as any)?.start ?? Math.floor(safeBase - ((cfg.startMinsAgo || 0) * 60 * 1000))
    const endMs = Math.floor(startMs + (cfg.endTotalMins * 60 * 1000))
    if (endMs > now) {
      activity.timestamps = {
        ...(activity.timestamps as object),
        end: endMs,
      }
    }
  }

  // Party
  if (cfg.partyMax != null && cfg.partyMax > 0) {
    const party: Record<string, unknown> = {
      size: [cfg.partyCurrent ?? 0, cfg.partyMax],
    }
    if (cfg.partyId) party.id = cfg.partyId
    if (cfg.partySecret) party.join = cfg.partySecret
    activity.party = party
  }

  // Assets (images)
  // Converted into WIRE-RENDERABLE values: URLs → mp:external references
  // (animated GIF capable) and asset keys → uploaded asset IDs. Gateway
  // presences never render raw URLs or bare keys (see discord-assets.ts).
  // With a custom Application ID the activity runs under the USER's own
  // application — 10X-scoped uploaded asset IDs would never render there, so
  // resolution is constrained to application-independent mp:external refs
  // (and pass-through of values the user owns, e.g. their app's asset IDs).
  const customAppId = cfg.appId && DISCORD_APP_ID_RE.test(cfg.appId) && !isGameApplicationId(cfg.appId) ? cfg.appId : null
  const assets: Record<string, string> = {}
  const assetOptsWithApp: ResolveOpts = { ...assetOpts, externalOnly: !!customAppId }
  const largeImageRef = await resolveAssetRef(cfg.largeImage, assetOptsWithApp)
  const smallImageRef = await resolveAssetRef(cfg.smallImage, assetOptsWithApp)
  if (largeImageRef) assets.large_image = largeImageRef
  if (cfg.largeText) assets.large_text = cfg.largeText
  if (smallImageRef) assets.small_image = smallImageRef
  if (cfg.smallText) assets.small_text = cfg.smallText
  if (Object.keys(assets).length > 0) activity.assets = assets

  // Buttons (max 2)
  // WIRE FORMAT (live-verified against gateway.gaming-sdk.com): `buttons` must be
  // an array of LABEL STRINGS; URLs ride in `metadata.button_urls` (exactly how
  // real Discord clients broadcast). Sending `buttons` as [{label,url}] objects is
  // INVALID — Discord silently drops the ENTIRE activity, which made the RPC
  // vanish from the profile whenever Button Config was saved ("RPC turns OFF" bug).
  const buttonLabels: string[] = []
  const buttonUrls: string[] = []
  if (cfg.button1Label && cfg.button1Url) {
    buttonLabels.push(cfg.button1Label)
    buttonUrls.push(cfg.button1Url)
  }
  if (cfg.button2Label && cfg.button2Url) {
    buttonLabels.push(cfg.button2Label)
    buttonUrls.push(cfg.button2Url)
  }
  if (buttonLabels.length > 0) {
    activity.buttons = buttonLabels
    activity.metadata = { button_urls: buttonUrls }
  }

  // Platform — send-side field for headless/embedded sessions
  if (cfg.platform) activity.platform = cfg.platform

  // A user-supplied Application ID presents the presence as THEIR application
  // (their own Discord app from the Developer Portal); otherwise the 10X app
  // identity is used. Game catalog ids (Minecraft, Valorant, ...) are NOT
  // valid custom ids for a normal slot — they are reserved for the isolated
  // Game RPC and are treated as unset here (→ 10X default).
  // NEVER send an empty application_id — Discord silently drops activities
  // carrying one. Omit the field instead (the gateway then attributes the
  // activity to the OAuth client itself).
  const resolvedAppId = customAppId || CONFIG.discord.clientId
  if (resolvedAppId) activity.application_id = resolvedAppId

  return activity
}

/**
 * Build Discord custom status activity payload (Activity Type 4).
 */
export function buildCustomStatusActivity(
  text: string | null,
  emoji: string | null
): Record<string, unknown> | null {
  if (!text && !emoji) return null
  const activity: Record<string, unknown> = {
    type: 4, // CUSTOM
    name: 'Custom Status',
  }
  if (text) activity.state = text
  if (emoji) {
    // Nitro custom emoji — canonical `<:name:id>` / `<a:name:id>` (animated), or bare `name:id`.
    // The gateway requires { name, id, animated } — sending the raw `<:name:id>` string as `name` does NOT render.
    const bracket = emoji.match(/^<(a?):([A-Za-z0-9_]+):(\d+)>$/)
    const bare = !bracket && /^[A-Za-z0-9_]+:\d+$/.test(emoji) ? emoji.match(/^([A-Za-z0-9_]+):(\d+)$/) : null
    if (bracket) {
      activity.emoji = { name: bracket[2], id: bracket[3], animated: bracket[1] === 'a' }
    } else if (bare) {
      activity.emoji = { name: bare[1], id: bare[2], animated: false }
    } else {
      // Unicode emoji (e.g. 😊)
      activity.emoji = { name: emoji }
    }
  }
  return activity
}

// ════════════════════════════════════════════════════════════════════════
// MULTI-RPC SELECTION (up to 3 slots) + GAME RPC — CANDIDATE MODEL
//
// The old single-RPC exclusivity model is upgraded to MULTI-RPC:
//   • Normal RPC  → up to 3 INDEPENDENT RpcConfig rows (slot 1..3), each with
//     its own fields AND its own enabled flag.
//   • Gamer RPC   → GameConfig row (enabled game preset, spoofed as real app).
//     STAYS COMPLETELY ISOLATED — enabling/disabling Game RPC never touches
//     any slot's data or flags, and vice versa.
//
// A candidate list is derived from the enabled flags only — rows are never
// copied, merged or overwritten across slots:
//   candidates = enabled RpcConfig slots (slot order) + enabled game (last)
//
// RUNTIME PRESENTATION (what is actually SENT to Discord):
//   • Simultaneous mode (default): ALL candidates in ONE authorized OP 3
//     activities array (Gaming SDK gateway, OAuth2 sdk.social_layer_presence
//     — the same authorized integration the site has always used; no raw
//     account tokens). Discord receives every activity; how many the client
//     RENDERS at once is Discord's own choice — which is why Auto Rotate
//     exists as the guaranteed-visible sequential alternative.
//   • Auto Rotate (optional, runtime-only): exactly ONE candidate is sent at
//     a time, advancing every `rotateSecs` deterministically from a stable
//     reference clock. Rotation NEVER deletes, resets, overwrites or
//     re-enables anything — saved configs are read-only here.
// ════════════════════════════════════════════════════════════════════════

export type RpcMode = 'normal' | 'game'

/** A candidate activity config — an enabled slot row or the synthesized game. */
export type RpcCandidate = RpcConfig & {
  gameSlug?: string
  gameName?: string
  slot?: number
  /** Resolved Discord Application ID for a CUSTOM game ("Add Games"). */
  gameAppId?: string | null
}

export interface MultiRpcSelection {
  /** Master RPC flag ON and at least one candidate is enabled. */
  active: boolean
  /**
   * Enabled RpcConfig slots (slot order) + the synthesized enabled game
   * configs appended LAST (Task 89 — MULTI-GAME: every enabled game runs as
   * its own candidate, so several Gamer RPCs can be live at once). Never a
   * merge across slots or games.
   */
  candidates: RpcCandidate[]
}

/** A single enabled-game input — one GameConfig row (or legacy single game). */
type EnabledGameInput = (RpcConfig & { gameSlug?: string; gameName?: string }) | null | undefined

/** Normalize the legacy single-game shape and the Task 89 array shape to a list. */
export function normalizeEnabledGames(enabledGame: EnabledGameInput | EnabledGameInput[]): Array<RpcConfig & { gameSlug?: string; gameName?: string }> {
  const list = Array.isArray(enabledGame) ? enabledGame : (enabledGame ? [enabledGame] : [])
  const out: Array<RpcConfig & { gameSlug?: string; gameName?: string }> = []
  const seen = new Set<string>()
  for (const g of list) {
    if (!g || g.enabled === false) continue
    const slug = (g as { gameSlug?: string }).gameSlug || `custom:${g.id ?? out.length}`
    if (seen.has(slug)) continue // defensive dedupe — one candidate per game
    seen.add(slug)
    out.push(g)
  }
  return out
}

/**
 * Collect the enabled candidates. Each slot's own `enabled` flag is the ONLY
 * thing that decides inclusion; every game candidate keeps its own flag too.
 * Task 89 — `enabledGame` accepts EITHER the legacy single game OR an array
 * of every enabled game (multi-Gamer-RPC).
 */
export function selectActiveRpcConfigs(
  rpcEnabled: boolean | null | undefined,
  rpcConfigs: Array<RpcConfig & { slot?: number }> | null | undefined,
  enabledGame: EnabledGameInput | EnabledGameInput[]
): MultiRpcSelection {
  const candidates: RpcCandidate[] = []
  const slots = (rpcConfigs ?? [])
    .filter(c => c.enabled)
    .slice()
    .sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99))
  candidates.push(...slots)

  // GAME RPCs — synthesized configs appended last (isolated from the slots).
  // (Defensive: also verifies each row's own enabled flag, so passing an
  // unfiltered GameConfig row can never activate a disabled game.)
  for (const game of normalizeEnabledGames(enabledGame)) {
    const gameName = (game as { gameName?: string }).gameName || game.name || 'Game'
    candidates.push({
      ...game,
      name: gameName,
      type: 'PLAYING',
      enabled: true,
    })
  }

  return { active: !!rpcEnabled && candidates.length > 0, candidates }
}

export interface RuntimeCandidateResult extends MultiRpcSelection {
  /** How the runtime picked what is being sent. */
  runtimeMode: 'single' | 'simultaneous' | 'rotate'
  /** 0-based index into the ROTATION POOL while rotating (else null). */
  rotateIndex: number | null
  /** Length of the rotation pool while rotating (else null). */
  rotatePoolLength: number | null
  /** Task 89 — the pool's candidate keys while rotating (else null). Lets the
   *  daemon pin exactly the enabled games the user LEFT OUT of the rotation. */
  rotatePoolKeys: string[] | null
}

/**
 * Task 89 — the ROTATION POOL for a selection. Shared by the daemon, /api/me
 * and the dashboard so every surface agrees on which candidates rotate.
 *
 * Task 95 — GAME AUTO-ROTATE INDEPENDENCE: Game RPCs now have their OWN
 * rotation system (/api/games/rotate + the daemon's gameRotate* reconcile).
 * Games therefore NEVER join the Normal RPC rotation pool — not via the
 * legacy includeGame flag and not via "game:<slug>" keys in the explicit
 * selection. The Normal rotation cycles through RPC SLOTS only; every
 * enabled game keeps its own always-visible session managed exclusively by
 * the game-rotation reconcile. The two systems share no state and no timers.
 *
 * `rotateSlotKeys` (Task 89 — the user's explicit "which RPCs rotate" pick):
 *   • array (even empty) → ONLY the candidates whose key is in the list join
 *     the pool (game keys filtered out).
 *   • null/undefined    → every enabled SLOT (games excluded).
 */
export function rotationPoolCandidates(
  sel: MultiRpcSelection,
  o: { rotateSlotKeys?: string[] | null; includeGame?: boolean | null }
): RpcCandidate[] {
  void o // includeGame is retired — games NEVER join the Normal pool (Task 95)
  const keys = Array.isArray(o.rotateSlotKeys)
    ? o.rotateSlotKeys.filter((k): k is string => typeof k === 'string' && k.length > 0 && !k.startsWith('game:'))
    : null
  const slotOnly = sel.candidates.filter(c => !c.gameSlug)
  if (keys) {
    const set = new Set(keys)
    const pool = slotOnly.filter(c => set.has(rpcCandidateKey(c)))
    // Empty explicit selection must never blank the profile — fall back to
    // the enabled SLOTS (never games — Task 95 independence).
    return pool.length > 0 ? pool : slotOnly
  }
  return slotOnly
}

/**
 * Task 106 — ALL created slots (enabled AND disabled) in stable slot order.
 * The Auto-Rotate explicit selection is honored against this FULL list: a
 * DISABLED slot the user picked for rotation still takes its turn. Sorting is
 * deterministic (slot number → createdAt → id) so the website, the preview
 * and every daemon node agree on the pool order forever.
 */
function allSlotCandidates(
  rows: Array<RpcCandidate & { slot?: number }> | null | undefined
): RpcCandidate[] {
  const tsOf = (v: unknown): number => {
    if (!v) return 0
    const t = new Date(v as string | Date).getTime()
    return Number.isFinite(t) ? t : 0
  }
  return (rows ?? [])
    .filter(c => c && !c.gameSlug)
    .slice()
    .sort((a, b) => {
      const sa = typeof a.slot === 'number' && a.slot >= 1 ? a.slot : 99
      const sb = typeof b.slot === 'number' && b.slot >= 1 ? b.slot : 99
      if (sa !== sb) return sa - sb
      const ta = tsOf((a as { createdAt?: unknown }).createdAt)
      const tb = tsOf((b as { createdAt?: unknown }).createdAt)
      if (ta !== tb) return ta - tb
      return (a.id || '').localeCompare(b.id || '')
    })
}

/**
 * Task 107 — public wrapper: EVERY created slot row (enabled AND disabled) in
 * the deterministic slot order (slot → createdAt → id). The display-type
 * inputs in Auto-Rotate mode are built from this list on ALL surfaces so the
 * assignment is identical everywhere (see buildGlobalDisplayTypeInputs).
 */
export function sortedSlotRows(
  rows: Array<RpcCandidate & { slot?: number }> | null | undefined
): RpcCandidate[] {
  return allSlotCandidates(rows)
}

/**
 * Task 106 — a RUNTIME-ONLY publishable copy of a rotation candidate. The
 * activity builder skips candidates whose `enabled` flag is false (that flag
 * governs the non-rotate Multi-Session mode); a slot taking its Auto-Rotate
 * turn is published exactly because the user SELECTED it for rotation, so the
 * copy stamps enabled:true WITHOUT ever touching the saved config row.
 */
function publishableRotationCandidate(c: RpcCandidate): RpcCandidate {
  return { ...c, enabled: true }
}

/**
 * Resolve which candidates are PUBLISHED right now.
 *
 * Auto Rotate (optional): picks exactly ONE candidate from the ROTATION POOL,
 * deterministically, by elapsed time from a stable reference — the index comes
 * from the shared pure math in rotation.ts (forward / reverse / shuffle, plus
 * the manual "Skip" counter). Task 95 — the pool is ALWAYS slots only:
 * games never join the Normal rotation (they run their own always-visible
 * extra sessions managed exclusively by the Game Auto-Rotate system).
 * Task 89 — `rotateSlotKeys` narrows the pool to exactly the slots the user
 * selected.
 * Task 106 — ROTATION SELECTION INDEPENDENCE: when an explicit selection is
 * stored, the pool is matched against `allRpcConfigs` (EVERY created slot,
 * enabled or not) — a DISABLED slot the user selected still rotates and
 * displays during its turn. The per-slot enable switch keeps governing the
 * non-rotate Multi-Session mode only; Auto Rotate never reads it for selected
 * slots and NEVER writes it (configs stay 100% read-only here).
 * Stateless across daemon restarts/multi-instance (same inputs → same index).
 * Auto Rotate is a RUNTIME-ONLY overlay: it never writes configs, never flips
 * enabled flags, never touches Game RPC settings, app IDs, buttons, images or
 * timestamps.
 */
export function resolveRuntimeCandidates(opts: {
  rpcEnabled: boolean | null | undefined
  rpcConfigs: Array<RpcConfig & { slot?: number }> | null | undefined
  /** Task 106 — EVERY slot row (enabled AND disabled). Required for the
   *  explicit-selection pool to include disabled-but-selected slots. When
   *  omitted the pool degrades to the enabled-only legacy rule. */
  allRpcConfigs?: Array<RpcConfig & { slot?: number }> | null
  enabledGame: EnabledGameInput | EnabledGameInput[]
  autoRotate?: boolean | null
  rotateSecs?: number | null
  /** Stable rotation clock anchor (ms epoch) — e.g. rotate settings' updatedAt. */
  rotateRefMs?: number | null
  /** Task 87 — rotation order (forward | reverse | shuffle). */
  rotateOrder?: RotateOrder | string | null
  /** Task 87 — manual advance counter ("Skip to next"). */
  rotateSkip?: number | null
  /** Task 87 — include the Game RPC in the rotation pool (default true). */
  rotateIncludeGame?: boolean | null
  /** Task 89 — explicit rotation pool (candidate keys). null = legacy rule. */
  rotateSlotKeys?: string[] | null
  /** Shuffle seed — the userId, so the permutation is stable per user. */
  rotateSeed?: string | null
  nowMs?: number
}): RuntimeCandidateResult {
  const sel = selectActiveRpcConfigs(opts.rpcEnabled, opts.rpcConfigs, opts.enabledGame)

  // ── Auto Rotate OFF — the classic Multi-Session paths (unchanged) ────────
  if (!opts.autoRotate) {
    if (!sel.active) {
      return { ...sel, runtimeMode: 'simultaneous', rotateIndex: null, rotatePoolLength: null, rotatePoolKeys: null }
    }
    if (sel.candidates.length === 1) {
      return { ...sel, runtimeMode: 'single', rotateIndex: null, rotatePoolLength: null, rotatePoolKeys: null }
    }
    return { ...sel, runtimeMode: 'simultaneous', rotateIndex: null, rotatePoolLength: null, rotatePoolKeys: null }
  }

  // ── Auto Rotate ON — build the pool ──────────────────────────────────────
  // Task 106 — the EXPLICIT selection matches ALL created slots (enabled AND
  // disabled). No explicit selection → the legacy rule (every ENABLED slot).
  const explicitKeys = Array.isArray(opts.rotateSlotKeys)
    ? opts.rotateSlotKeys.filter((k): k is string => typeof k === 'string' && k.length > 0 && !k.startsWith('game:'))
    : null
  let pool: RpcCandidate[]
  if (explicitKeys) {
    const allSlots = allSlotCandidates(opts.allRpcConfigs ?? opts.rpcConfigs)
    const set = new Set(explicitKeys)
    const picked = allSlots.filter(c => (c.id ? set.has(c.id) : false))
    // Empty explicit pick (or a legacy caller without allRpcConfigs) must
    // never blank the profile — fall back to the enabled-slot legacy rule.
    pool = picked.length > 0
      ? picked
      : rotationPoolCandidates(sel, { rotateSlotKeys: explicitKeys, includeGame: opts.rotateIncludeGame })
  } else {
    pool = rotationPoolCandidates(sel, { rotateSlotKeys: null, includeGame: opts.rotateIncludeGame })
  }

  // The pool can drive the presence even when NO slot is enabled: the user
  // selected slots (some disabled) for rotation and master RPC is on.
  const poolCanDrive = !!opts.rpcEnabled && pool.length > 0
  if (!sel.active && !poolCanDrive) {
    return { ...sel, runtimeMode: 'simultaneous', rotateIndex: null, rotatePoolLength: null, rotatePoolKeys: null }
  }
  if (pool.length < 2) {
    // Nothing to cycle. Preserve the exact non-rotate presentation, EXCEPT
    // the rotation-only case: the single pool member is a DISABLED slot the
    // user explicitly selected → publish it (the selection is what keeps it
    // visible while Auto Rotate is on).
    if (!sel.active && pool.length === 1) {
      return {
        active: true,
        candidates: [publishableRotationCandidate(pool[0])],
        runtimeMode: 'single',
        rotateIndex: null,
        rotatePoolLength: null,
        rotatePoolKeys: null,
      }
    }
    if (sel.active && sel.candidates.length === 1) {
      return { ...sel, runtimeMode: 'single', rotateIndex: null, rotatePoolLength: null, rotatePoolKeys: null }
    }
    return { ...sel, runtimeMode: 'simultaneous', rotateIndex: null, rotatePoolLength: null, rotatePoolKeys: null }
  }
  const idx = rotateCycleIndex({
    refMs: opts.rotateRefMs,
    secs: Number(opts.rotateSecs ?? 30),
    skip: opts.rotateSkip,
    order: normalizeRotateOrder(opts.rotateOrder),
    length: pool.length,
    seed: opts.rotateSeed ?? null,
    nowMs: opts.nowMs,
  })
  return {
    active: true,
    candidates: [publishableRotationCandidate(pool[idx])],
    runtimeMode: 'rotate',
    rotateIndex: idx,
    rotatePoolLength: pool.length,
    rotatePoolKeys: pool.map(rpcCandidateKey),
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Task 92 — GLOBAL DISPLAY-TYPE ORCHESTRATION (the "3 RPCs at once" fix).
//
// ROOT CAUSE (verified 2026-10-14 inside Discord's shipped web-client bundle,
// SelfPresenceStore + PresenceStore): the profile activity list is computed as
//   display = prune(uniqBy(`${type}:${application_id}:${name}`)([...activities]))
//   prune:  if MORE THAN ONE PLAYING-type activity exists → exactly ONE
//           survives (the sort-first one); non-PLAYING types are NEVER pruned.
// Every simultaneous card the daemons pushed was type 0 (PLAYING), so the
// client collapsed the whole set to a single card no matter how many gateway
// sessions carried them (server-side aggregates always held all activities).
//
// Task 93 — GAME RPCs ARE PINNED TO PLAYING (user directive, supersedes the
// multi-PLAYING prune workaround):
//   "All Game RPCs must always display the status as Playing. Ensure every
//    Game RPC stays in the Playing state and does not switch to any other
//    status."
// Every game candidate therefore ALWAYS presents as PLAYING (type 0). It is
// never re-labeled to WATCHING / LISTENING / COMPETING, never yields the
// PLAYING position to another candidate, and ignores rotate-mode neverPlaying.
// The at-most-one-PLAYING + duplicate-triple rules now apply ONLY among the
// NON-game candidates (Normal slots + the Application RPC), which are exactly
// the cards that visibly collapsed when they shared type 0.
//
// Remaining hard client rule for non-game cards:
//   1. AT MOST ONE non-game candidate presents as PLAYING — every further
//      PLAYING-configured candidate is re-labeled to WATCHING / LISTENING /
//      COMPETING (all real Discord activity types, rendered as their own card).
//   2. No two cards may share the (type, application_id, name) triple —
//      duplicates collapse via the client's uniqBy. A re-label (or substitute)
//      always resolves same-app same-name duplicates (e.g. a Normal slot and
//      the Application RPC both on the 10X app, both named "10X RPC").
//
// The assignment is GLOBAL across all three RPC systems (Normal slots + Game
// RPCs + Application RPC) and DETERMINISTIC: a pure function of the saved
// configs in a fixed order (slots by slot number, games by creation, the
// Application RPC last). Both daemons (rpc-daemon.ts + application-rpc-
// daemon.ts) compute the SAME assignment independently from the DB — no
// cross-process coordination needed.
// ════════════════════════════════════════════════════════════════════════════

/** Substitute activity types (real Discord enum values) used when a
 *  PLAYING-configured candidate must yield the single PLAYING card. */
const DISPLAY_TYPE_SUBSTITUTES = ['WATCHING', 'LISTENING', 'COMPETING'] as const

export interface DisplayTypeCandidate {
  /** Stable identity (RpcConfig id, "game:<slug>" or "app_rpc"). */
  key: string
  /** Activity display name as it will be pushed. */
  name: string
  /** Application ID the card presents under (null for spoofed games). */
  appId: string | null
  /** Configured type string ('PLAYING' | 'WATCHING' | …); null → PLAYING. */
  configuredType: string | null
  /** Task 93 — true for Game RPC candidates: pinned to PLAYING forever. */
  kind?: 'game'
}

/**
 * Task 107 — ONE shared constructor for the GLOBAL display-type assignment
 * inputs, used verbatim by ALL THREE surfaces (rpc-daemon.ts, application-
 * rpc-daemon.ts, /api/me) so every process computes the IDENTICAL assignment
 * from the same rows. Order: games FIRST (pinned PLAYING, Task 105), then
 * slots, then the Application RPC.
 *
 * `slots` semantics per mode:
 *   • Auto Rotate ON  → EVERY created slot (enabled AND disabled) in stable
 *     slot order. A DISABLED-but-selected slot takes rotation turns and IS
 *     pushed during its turn — before this change it was missing from the
 *     inputs, kept its configured PLAYING, and was pruned by the client
 *     against the game's pinned PLAYING card (the "RPC3 not showing during
 *     its rotation turn" bug). Extra disabled rows in the assignment are
 *     harmless: every surface includes them identically, and only PUSHED
 *     cards are subject to the client prune.
 *   • Auto Rotate OFF → enabled slots only (the pushed set).
 */
export function buildGlobalDisplayTypeInputs(src: {
  slots: Array<{ id?: string | null; name?: string | null; appId?: string | null; type?: string | null; gameSlug?: string | null } | null | undefined>
  games: Array<{ id?: string | null; gameSlug?: string | null; gameName?: string | null; name?: string | null } | null | undefined>
  appRpc?: { name: string | null; appId: string | null; type: string | null } | null
}): DisplayTypeCandidate[] {
  return [
    // Games FIRST — the pinned game consumes the single global PLAYING card.
    ...(src.games ?? [])
      .filter((g): g is { id?: string | null; gameSlug?: string | null; gameName?: string | null; name?: string | null } => !!g)
      .map(g => ({
        key: `game:${g.gameSlug ?? g.id ?? 'unknown'}`,
        name: g.gameName || g.name || 'Game',
        appId: null,
        configuredType: 'PLAYING',
        kind: 'game' as const,
      })),
    ...(src.slots ?? [])
      .filter((s): s is { id?: string | null; name?: string | null; appId?: string | null; type?: string | null; gameSlug?: string | null } => !!s && !s.gameSlug)
      .map(s => ({
        key: s.id ?? '',
        name: s.name ?? '',
        appId: s.appId ?? null,
        configuredType: s.type ?? null,
      })),
    ...(src.appRpc
      ? [{ key: 'app_rpc', name: src.appRpc.name ?? '', appId: src.appRpc.appId, configuredType: src.appRpc.type }]
      : []),
  ]
}

/**
 * Assign each candidate a DISPLAY activity type so Discord's client renders
 * every card simultaneously (rules above). Returns key → type string.
 *
 * Task 93 — Game RPC candidates (kind: 'game') are PINNED to PLAYING:
 * they never switch to another status, in any mode, ever.
 *
 * @param neverPlayingKeys non-game candidates that must NEVER present as
 *   PLAYING (rotate-mode pinned slot extras / the Application RPC while Auto
 *   Rotate runs — the rotating main session owns the PLAYING card in that
 *   mode). Games are exempt by definition.
 * @param preferredPlayingKey Task 109 — the non-game candidate that OWNS the
 *   single PLAYING card when it is free. Auto-Rotate mode passes the ROTATING
 *   candidate (the only slot card actually being pushed): without this, the
 *   first slot in the input order consumed PLAYING even when it was NOT being
 *   pushed, and the rotating card degraded to WATCHING / LISTENING /
 *   COMPETING ("Competing in 10X RPC") even when NO game existed. Evaluated
 *   right after the pinned games so every surface (rpc-daemon, application-
 *   rpc-daemon, /api/me) reaches the identical assignment.
 */
export function assignDisplayTypes(
  cands: DisplayTypeCandidate[],
  neverPlayingKeys: ReadonlySet<string> = new Set(),
  preferredPlayingKey?: string | null
): Map<string, string> {
  // Task 109 — evaluation order: pinned games first, then the preferred
  // PLAYING owner (the rotating card), then everything else in input order.
  // Deterministic and identical on every surface that passes the same key.
  const ordered = preferredPlayingKey
    ? [
        ...cands.filter(c => c.kind === 'game'),
        ...cands.filter(c => c.kind !== 'game' && c.key === preferredPlayingKey),
        ...cands.filter(c => c.kind !== 'game' && c.key !== preferredPlayingKey),
      ]
    : cands
  const out = new Map<string, string>()
  const used = new Set<string>()
  const tripleOf = (c: DisplayTypeCandidate, ty: string) => `${ty}|${c.appId ?? ''}|${c.name}`
  let playingTaken = false
  let subIdx = 0
  for (const c of ordered) {
    const configured = (c.configuredType || 'PLAYING').toUpperCase()
    let t: string
    if (c.kind === 'game') {
      // Task 93 — Game RPCs ALWAYS present as PLAYING (type 0). The
      // "Playing <Game>" status is the product contract for the Game RPC
      // system: no substitute, no rotate-mode demotion, no collapse-driven
      // re-labeling. Distinct game names / spoofed app ids keep every game
      // card's (type, application_id, name) triple unique by construction.
      // Task 107 — the game ALSO CONSUMES the single global PLAYING slot
      // (playingTaken): Discord's client prune keeps exactly ONE PLAYING
      // activity across the WHOLE profile, so the pinned game's PLAYING
      // blocks every later non-game PLAYING candidate. Without this stamp
      // the first PLAYING-configured slot after a game ALSO presented as
      // PLAYING → two PLAYING cards → the client pruned one → the
      // "RPC not showing / flip-flopping" bug the games-first input order
      // was supposed to prevent but could not on its own.
      t = 'PLAYING'
      playingTaken = true
    } else if ((configured === 'PLAYING' && !playingTaken && !neverPlayingKeys.has(c.key))) {
      t = 'PLAYING'
      playingTaken = true
    } else if (configured !== 'PLAYING' && !neverPlayingKeys.has(c.key) && !used.has(tripleOf(c, configured))) {
      t = configured
    } else {
      // A further PLAYING-configured candidate, a rotate-mode never-PLAYING
      // candidate, or a colliding (type, app, name) duplicate → walk the
      // substitute pool deterministically until the triple is unique.
      t = ''
      for (let k = 0; k < DISPLAY_TYPE_SUBSTITUTES.length * 2; k++) {
        const cand = DISPLAY_TYPE_SUBSTITUTES[(subIdx + k) % DISPLAY_TYPE_SUBSTITUTES.length]
        if (!used.has(tripleOf(c, cand))) {
          t = cand
          subIdx = (subIdx + k + 1) % DISPLAY_TYPE_SUBSTITUTES.length
          break
        }
      }
      if (!t) t = 'WATCHING' // substitute pool exhausted (degenerate config)
    }
    used.add(tripleOf(c, t))
    out.set(c.key, t)
  }
  return out
}

// ════════════════════════════════════════════════════════════════════════════
// APPLICATION-ID DE-COLLISION — RETIRED (Task 85).
// The Task 84b "shell id" overlay assigned GAME catalog application ids to
// duplicate normal slots at runtime. Per the product rule ("normal RPCs run
// under the 10X RPC application unless the user supplies their own custom
// Application ID; game ids are Game-RPC-only") the overlay is NO LONGER WIRED
// anywhere: every normal slot resolves to customAppId || CONFIG.discord.clientId
// and simultaneous rendering relies on each session's DISTINCT platform class
// (Task 84c/84d). Kept only as reference for the Task 84b test script.
// ════════════════════════════════════════════════════════════════════════════

/** Deterministic shell pool — real public application IDs (GAME_SPOOF order). */
export const RPC_SHELL_APPLICATION_IDS: string[] = Array.from(
  new Set(Object.values(GAME_SPOOF).map(e => e.appId))
)

/** Candidate map key — stable, mirrors the daemon's slot-session key. Exported
 *  for the rotate-settings surfaces (API + UI selection chips, Task 89).
 *  Game candidates ALWAYS key as "game:<slug>" (the slug is the stable
 *  identity the dashboard selection stores); slot candidates key by row id. */
export function rpcCandidateKey(cfg: RpcCandidate): string {
  if (cfg.gameSlug) return `game:${cfg.gameSlug}`
  return cfg.id || ''
}

/**
 * A candidate's effective Application ID exactly as the activity builder
 * resolves it (slot appId → per-row daemon fallback map → 10X default;
 * game candidates present as their spoofed official application).
 */
function resolveCandidateEffectiveAppId(
  cfg: RpcCandidate,
  rpcAppIdMap: Map<string, string> | null | undefined
): string {
  if (cfg.gameSlug) {
    const activeGame = findGame(cfg.gameSlug)
    const spoof: GameSpoofEntry | undefined
      = activeGame && cfg.name === activeGame.name ? GAME_SPOOF[activeGame.slug] : undefined
    if (spoof) return spoof.appId
    if (cfg.gameAppId && DISCORD_APP_ID_RE.test(cfg.gameAppId)) return cfg.gameAppId
  }
  // Normal slot: the user's own custom Application ID wins; a game catalog id
  // stored on the row is treated as unset (game ids are Game-RPC-only);
  // everything else defaults to the 10X RPC application.
  if (cfg.appId && DISCORD_APP_ID_RE.test(cfg.appId) && !isGameApplicationId(cfg.appId)) return cfg.appId
  const fallback = cfg.id && rpcAppIdMap ? rpcAppIdMap.get(cfg.id) : null
  if (fallback && DISCORD_APP_ID_RE.test(fallback) && !isGameApplicationId(fallback)) return fallback
  return CONFIG.discord.clientId
}

/**
 * Compute runtime Application-ID overrides for a SIMULTANEOUS candidate list.
 * Returns a map keyed by rpcCandidateKey(cfg) → replacement application id
 * for every candidate whose effective id is already taken by an earlier
 * candidate (or by the Game RPC, whose official id is always reserved).
 * Empty map = nothing collides = identities pass through untouched.
 */
export function assignCandidateApplicationIds(
  candidates: RpcCandidate[],
  opts?: { rpcAppIdMap?: Map<string, string> | null }
): Map<string, string> {
  const overrides = new Map<string, string>()
  if (!candidates || candidates.length < 2) return overrides
  const used = new Set<string>()

  // Pass 1 — Game RPC candidates NEVER yield their official application id.
  for (const cfg of candidates) {
    if (!cfg.gameSlug) continue
    used.add(resolveCandidateEffectiveAppId(cfg, opts?.rpcAppIdMap))
  }

  // Pass 2 — slots in order: the first occurrence of an id keeps it; every
  // further duplicate gets the next free shell id (deterministic → stable).
  let shellIdx = 0
  for (const cfg of candidates) {
    if (cfg.gameSlug) continue
    const id = resolveCandidateEffectiveAppId(cfg, opts?.rpcAppIdMap)
    if (!used.has(id)) {
      used.add(id)
      continue
    }
    let shell: string | null = null
    while (shellIdx < RPC_SHELL_APPLICATION_IDS.length) {
      const candidate = RPC_SHELL_APPLICATION_IDS[shellIdx++]
      if (!used.has(candidate)) {
        shell = candidate
        break
      }
    }
    if (shell) {
      used.add(shell)
      overrides.set(rpcCandidateKey(cfg), shell)
    }
    // Shell pool exhausted → leave the duplicate as-is (best effort; with
    // ≤3 slots + 1 game at most 3 shells are ever needed).
  }
  return overrides
}

/**
 * ════════════════════════════════════════════════════════════════════════
 * Task 84c — PLATFORM-CLASS DE-DUPLICATION for simultaneous Multi-Session.
 *
 * ROOT CAUSE (live-verified via daemon boot logs + user screenshots): Discord
 * classifies every gateway session into one of FIVE platform classes from the
 * IDENTIFY properties (desktop / mobile / console / VR / web — see
 * gateway-platform.ts), merges concurrent sessions PER CLASS with last-write-
 * wins, and the client renders ONE activity card per class. Two extra sessions
 * that both identify `desktop` (e.g. RPC slot 2 + the Game RPC) collapse into
 * a single card — the later push wins — which is exactly why only 2 of 3 RPCs
 * ever rendered. Application-ID de-collision (Task 84b) could not fix this:
 * the merge key is the session's platform class, not the application id.
 *
 * THE FIX: every simultaneous session gets a DISTINCT platform class. The
 * main session keeps its own platform (badge fidelity); each extra session
 * re-uses its candidate's platform when that class is free, otherwise takes
 * the first free class from a deterministic fallback pool. Up to 5 sessions
 * (5 classes) can therefore render 5 cards side by side.
 * ════════════════════════════════════════════════════════════════════════
 */

/** Discord's session classes derived from IDENTIFY properties (must mirror
 *  gateway-platform.ts buildIdentify classification). */
export type DiscordPlatformClass = 'desktop' | 'mobile' | 'console' | 'vr' | 'web'

export function discordPlatformClass(
  platform: string | null | undefined
): DiscordPlatformClass {
  const p = platform || 'desktop'
  if (p === 'meta_quest') return 'vr'
  if (p === 'android' || p === 'ios' || p === 'samsung' || p === 'mobile') return 'mobile'
  if (p === 'console' || p === 'xbox' || p === 'ps4' || p === 'ps5' || p === 'embedded') {
    return 'console'
  }
  if (p === 'web') return 'web'
  return 'desktop'
}

/** Deterministic assignment pool for EXTRA (beyond-main) sessions.
 *  Task 91 REWRITE — the pool now contains ONLY platforms that are ALSO valid
 *  ACTIVITY-level `platform` enum values. WHY: live-verified (Task 91 aggregate
 *  dumps) — the Discord client merges rendered profile cards by the ACTIVITY's
 *  own `platform` field, NOT by the session's gateway class. Three game extras
 *  on web/android/embedded sessions all shipped WITHOUT an activity label, so
 *  Discord defaulted every one of them to platform:"desktop" and the client
 *  collapsed all three into a single card (and the user's real desktop client
 *  — also desktop-labeled — wiped the group entirely). Distinct labels are the
 *  actual multi-card mechanism.
 *
 *  Task 84d history kept for context: real clients permanently occupy the
 *  `mobile` class (phone) and often `desktop`/`web`. The pool therefore
 *  prefers the CONSOLE family (labels no real client emits, zero contention)
 *  and only then mobile labels. 'web' and 'desktop' are deliberately ABSENT:
 *  there is no 'web' activity enum value (activities from web sessions are
 *  labeled 'desktop'), so web/desktop sessions can never carry a DISTINCT
 *  label and would merge with the user's real desktop card. */
const EXTRA_PLATFORM_FALLBACK_POOL = ['ps4', 'xbox', 'android', 'ios'] as const

/** Discord's ACTIVITY-level platform enum (docs.discord.food Activity Object).
 *  Values outside this list cause the WHOLE activity to be silently rejected
 *  by the gateway (Task 84d: 'web'/'mobile' never stored). */
const ACTIVITY_PLATFORM_ENUM: ReadonlySet<string> = new Set([
  'desktop', 'xbox', 'samsung', 'ios', 'android', 'embedded', 'ps4', 'ps5', 'meta_quest',
])

/** True when `p` may be sent as an activity-level `platform` field. */
export function isValidActivityPlatform(p: string | null | undefined): boolean {
  return !!p && ACTIVITY_PLATFORM_ENUM.has(p)
}

/**
 * Task 110 — the activity-level platform LABEL the RPC-role MAIN card should
 * carry. Screenshot bug this fixes: a slot the user configured with the Xbox
 * platform rendered with the wrong/forced label — the Task 105 anchor stamped
 * EVERY main card 'ps4' unconditionally, overwriting the builder's own stamp
 * (buildActivityPayload sets `platform: cfg.platform`) and breaking the RPC
 * DEVICE/PLATFORM feature (the console badge IS the feature).
 *
 * Rule: the slot's CONFIGURED platform is honored when it is
 *   • a valid ACTIVITY enum value (invalid legacy values — 'console', 'web',
 *     'mobile' — get the whole activity REJECTED by the gateway, Task 84d,
 *     so they must never ride the wire), and
 *   • NOT a label group occupied by a real client or reserved for another
 *     role's main card:
 *       - desktop              → wiped by the user's real desktop client
 *                                (live-verified Task 91/105 failure)
 *       - android/ios/samsung  → real phone clients occupy these groups
 *       - embedded             → the GAME role's main card label (merge key)
 * Everything else (xbox / ps4 / ps5 / meta_quest) is honored as-is — those
 * labels collide with neither real clients nor sibling cards (the extras
 * pool never receives the main card's label — see rpc-daemon extrasMainLabel).
 * Unset / desktop / legacy configs fall back to the collision-safe anchor
 * platform ('ps4' — Task 105: labels no real client emits, so a lone slot
 * card can always render).
 */
const REAL_CLIENT_OR_RESERVED_LABELS: ReadonlySet<string> = new Set([
  'desktop', 'android', 'ios', 'samsung', 'embedded',
])

export function resolveRpcMainCardLabel(
  candidatePlatform: string | null | undefined,
  anchorPlatform: string | null | undefined
): string | null {
  const configured = typeof candidatePlatform === 'string' ? candidatePlatform.trim() : ''
  if (
    configured &&
    isValidActivityPlatform(configured) &&
    !REAL_CLIENT_OR_RESERVED_LABELS.has(configured)
  ) {
    return configured
  }
  // The anchor obeys the same rule — an anchor inside a real-client/reserved
  // label group ('desktop', phone groups, the game role's 'embedded') must
  // never be stamped onto the main card (Task 91: desktop-labeled cards are
  // wiped by the user's real desktop client — the invisible-card bug).
  const anchor = typeof anchorPlatform === 'string' ? anchorPlatform.trim() : ''
  if (anchor && isValidActivityPlatform(anchor) && !REAL_CLIENT_OR_RESERVED_LABELS.has(anchor)) {
    return anchor
  }
  return null
}

/**
 * Assign each extra (beyond-main) session a platform whose VALUE (and hence
 * the activity card label) is unique across all concurrent sessions.
 * Deterministic → assignments never churn between ticks (sessions reopen
 * only when the assignment actually changes).
 *
 * Task 91 — uniqueness moved from SESSION CLASS to PLATFORM VALUE: the client
 * merges rendered cards by the activity's `platform` field (live-verified —
 * extras on DISTINCT gateway classes but all defaulting to the 'desktop'
 * activity label collapsed into one card). The pool therefore contains only
 * valid activity-enum values, and two extras may now share a gateway class
 * (ps4+xbox are both console) as long as their LABELS differ.
 *
 * Task 84d — the candidate's OWN platform is still deliberately NOT preferred:
 * slot configs are overwhelmingly `desktop`/`meta_quest`, and a desktop extra
 * merges with the user's real desktop card while a meta_quest extra merges
 * with the MAIN session's card. Extras always come from the collision-safe
 * pool; the card content (name/icon/state) is unaffected by the label.
 *
 * Task 84d — STABLE HINTS: assignments are anchored to each candidate's own
 * slot number (slot 2 → pool[0], slot 3 → pool[1], …; game → pool[0]).
 * Enabling/disabling a MIDDLE slot therefore never reshuffles the others
 * (no reopen churn, no zombie sessions, no flicker). When a hinted value is
 * taken the scan advances deterministically.
 *
 * @param mainPlatform the platform the MAIN session identifies (and labels) as
 * @param candidatePlatforms own platform of each EXTRA candidate, in order
 * @param stableHints desired pool index per candidate (same order), or null
 * @returns assigned platform per candidate (same order); `null` = no free
 *          label remained (candidate is appended to the main push as fallback).
 */
export function assignSessionPlatforms(
  mainPlatform: string | null | undefined,
  candidatePlatforms: Array<string | null | undefined>,
  stableHints?: Array<number | null | undefined>
): Array<string | null> {
  const taken = new Set<string>([mainPlatform || 'desktop'])
  return candidatePlatforms.map((own, i) => {
    const hint = stableHints?.[i]
    const start = typeof hint === 'number' ? ((hint % EXTRA_PLATFORM_FALLBACK_POOL.length) + EXTRA_PLATFORM_FALLBACK_POOL.length) % EXTRA_PLATFORM_FALLBACK_POOL.length : 0
    for (let k = 0; k < EXTRA_PLATFORM_FALLBACK_POOL.length; k++) {
      const p = EXTRA_PLATFORM_FALLBACK_POOL[(start + k) % EXTRA_PLATFORM_FALLBACK_POOL.length]
      if (!taken.has(p)) {
        taken.add(p)
        return p
      }
    }
    return null
  })
}

/**
 * Coherent ACTIVITY-level `platform` field for a session platform: values
 * Discord's clients actually emit ('android'/'ios'/'samsung' sessions push
 * activities labelled 'mobile'; consoles keep their specific label).
 */
export function activityPlatformField(platform: string | null | undefined): string {
  const p = platform || 'desktop'
  if (p === 'android' || p === 'ios' || p === 'samsung') return 'mobile'
  return p
}

/**
 * @deprecated legacy single-mode selection — kept ONLY for callers not yet
 * migrated (or external scripts). Preserves the exact legacy behavior: an
 * enabled game wins over a normal config. New code must use
 * selectActiveRpcConfigs / resolveRuntimeCandidates.
 */
export function selectActiveRpc(
  rpcEnabled: boolean | null | undefined,
  rpcConfig: RpcConfig | null | undefined,
  enabledGame: (RpcConfig & { gameSlug?: string; gameName?: string }) | null | undefined
): {
  active: boolean
  mode: RpcMode | null
  config: RpcConfig | null
  gameSlug: string | null
} {
  if (enabledGame && enabledGame.enabled !== false) {
    const gameName = (enabledGame as { gameName?: string }).gameName || enabledGame.name || 'Game'
    return {
      active: !!rpcEnabled,
      mode: 'game',
      config: { ...enabledGame, name: gameName, type: 'PLAYING', enabled: true },
      gameSlug: (enabledGame as { gameSlug?: string }).gameSlug ?? null,
    }
  }
  if (rpcConfig && rpcConfig.enabled) {
    return { active: !!rpcEnabled, mode: 'normal', config: rpcConfig, gameSlug: null }
  }
  return { active: false, mode: null, config: null, gameSlug: null }
}

/**
 * Build the full activities array for Discord Gateway OP 3.
 * Supports Custom Status (type 4) AND MULTIPLE Rich Presence activities
 * (type 0..5) simultaneously — one activity per enabled candidate:
 * up to 3 normal RPC slots + the enabled game (isolated Game RPC).
 *
 * Legacy singular inputs (rpcConfig plus the selectedGame / rpcAppId hints)
 * are wrapped into the candidate list so pre-multi-RPC callers keep working.
 */
export async function buildPresenceActivities(options: {
  /** Multi-RPC candidate list (enabled slots + synthesized game). */
  rpcConfigs?: Array<RpcCandidate> | null
  /** Legacy alias — wrapped into the candidate list. */
  rpcConfig?: RpcConfig | null
  customStatus?: string | null
  customStatusEmoji?: string | null
  placeholderCtx?: PlaceholderContext
  vrStatusActive?: boolean
  platform?: string
  /** User OAuth token — enables external-asset resolution (animated GIFs). */
  userAccessToken?: string | null
  /** Legacy: ENABLED game slug for the singular config (game spoofing). */
  selectedGameSlug?: string | null
  /** Legacy: Discord Application ID for CUSTOM games (singular path). */
  selectedGameAppId?: string | null
  /**
   * Legacy: Discord Application ID fallback for the singular NORMAL config
   * (queryRaw read for pre-appId Prisma clients). cfg.appId wins.
   */
  rpcAppId?: string | null
  /** Per-row appId fallbacks for the multi path (fetchRpcAppIds). */
  rpcAppIdMap?: Map<string, string> | null
}): Promise<Array<Record<string, unknown>>> {
  const activities: Array<Record<string, unknown>> = []

  // 1. Custom status activity (type 4)
  const customActivity = buildCustomStatusActivity(
    options.customStatus || null,
    options.customStatusEmoji || null
  )
  if (customActivity) {
    activities.push(customActivity)
  }

  // 2. Candidate list (multi first, then the legacy singular wrapped in)
  const candidates: RpcCandidate[] = [...(options.rpcConfigs ?? [])]
  if (options.rpcConfig) {
    const legacy: RpcCandidate = {
      ...options.rpcConfig,
      gameSlug: options.selectedGameSlug ?? undefined,
      gameAppId: options.selectedGameAppId ?? null,
    }
    if (options.rpcAppId && !DISCORD_APP_ID_RE.test(legacy.appId || '')) {
      legacy.appId = options.rpcAppId
    }
    candidates.push(legacy)
  }

  const ctx = options.placeholderCtx || {
    timezone: 'UTC',
    rpcStartedAt: Date.now(),
  }

  for (const cfg of candidates) {
    if (cfg.enabled === false && !cfg.gameSlug) continue
    // Per-candidate elapsed clock: every slot's "elapsed" timer runs from its
    // OWN last save (row updatedAt), not the first slot's — with Multi-Session
    // each activity card shows its own correct elapsed time.
    const ownUpdated = (cfg as { updatedAt?: Date | string | null }).updatedAt
    const ownMs = ownUpdated ? new Date(ownUpdated as unknown as string | Date).getTime() : NaN
    const perCtx: PlaceholderContext = Number.isFinite(ownMs) && ownMs > 0 ? { ...ctx, rpcStartedAt: ownMs } : ctx
    const activity = await buildCandidateActivity(cfg, perCtx, options)
    if (activity) activities.push(activity)
  }

  return activities
}

/**
 * Build ONE Discord activity payload from a candidate config.
 * Per-candidate: its own platform/VR handling, its own Application ID
 * (slot appId → per-row queryRaw fallback), and its own game spoofing
 * (official GAME_SPOOF entry or the custom game's application identity).
 */
async function buildCandidateActivity(
  cfg: RpcCandidate,
  placeholderCtx: PlaceholderContext,
  options: {
    vrStatusActive?: boolean
    platform?: string
    userAccessToken?: string | null
    rpcAppIdMap?: Map<string, string> | null
  }
): Promise<Record<string, unknown> | null> {
  const ctx = placeholderCtx

  // VR resolution per candidate: the slot's OWN platform decides; the global
  // VR status flag only applies when the candidate doesn't carry a platform.
  const explicitPlatform = cfg.platform || (options.platform ?? undefined)
  const isVr = explicitPlatform === 'meta_quest'
    || (!!options.vrStatusActive && (!explicitPlatform || explicitPlatform === 'meta_quest'))

  // Per-slot Application ID: the row's own value first, then the daemon's
  // queryRaw per-row map (pre-appId Prisma clients). Game candidates ignore
  // this — their spoof logic overrides application_id below.
  let cfgForBuild: RpcConfig = cfg
  const fallbackAppId = cfg.id && options.rpcAppIdMap ? options.rpcAppIdMap.get(cfg.id) : null
  if (!cfg.gameSlug && fallbackAppId && !DISCORD_APP_ID_RE.test(cfgForBuild.appId || '') && !isGameApplicationId(fallbackAppId)) {
    cfgForBuild = { ...cfgForBuild, appId: fallbackAppId }
  }

  const activity = (await buildActivityPayload(cfgForBuild, ctx, {
    userAccessToken: options.userAccessToken,
  })) as Record<string, unknown>

  if (isVr) {
    activity.platform = 'meta_quest'
    if (!activity.state) {
      activity.state = 'In Virtual Reality'
    }
  }
  // Activity Name is ALWAYS prioritized from custom NAME, falling back to platform name only when NAME is empty.
  activity.name = resolveRpcActivityName(cfg.name, isVr ? 'meta_quest' : explicitPlatform)

  // Game spoof — the candidate is the isolated GAME RPC when it carries a
  // gameSlug: present the activity as the game's OFFICIAL application (real
  // application_id + official display name + official app icon), or as the
  // custom game's own application when the user supplied an ID.
  if (cfg.gameSlug) {
    const activeGame = findGame(cfg.gameSlug)
    let spoof: GameSpoofEntry | undefined
      = activeGame && cfg.name === activeGame.name ? GAME_SPOOF[activeGame.slug] : undefined
    if (!spoof && cfg.gameAppId && cfg.name) {
      spoof = {
        appId: cfg.gameAppId,
        name: cfg.name,
        icon: cfg.largeImage && /^https?:\/\//i.test(cfg.largeImage) ? cfg.largeImage : '',
      }
    }
    if (spoof) {
      activity.application_id = spoof.appId
      activity.name = spoof.name
      const assets = (activity.assets as Record<string, string> | undefined) ?? {}
      // Spoof icons must ONLY ride app-independent external media references
      // (mp:external/...): uploaded asset IDs are scoped to the 10X application
      // and can NOT render once application_id is spoofed to the game's own
      // app. resolveExternalAsset never produces asset IDs and keeps its own
      // in-memory cache, so shared DB cache rows can never poison this path.
      const rawIcon = options.userAccessToken && spoof.icon
        ? await resolveExternalAsset(spoof.icon, options.userAccessToken)
        : null
      const iconRef = rawIcon && rawIcon.startsWith('mp:') ? rawIcon : null
      if (iconRef) {
        assets.large_image = iconRef
        if (!assets.large_text) assets.large_text = spoof.name
      } else {
        // No renderable official icon (no token / resolution failed): drop image
        // references entirely — 10X-scoped asset IDs would render nothing under
        // the spoofed application and only reserve a dead image slot.
        delete assets.large_image
        delete assets.large_text
      }
      if (assets.small_image && !String(assets.small_image).startsWith('mp:')) {
        // Small image asset IDs are 10X-application scoped too — drop unrenderable ones.
        delete assets.small_image
        delete assets.small_text
      }
      if (Object.keys(assets).length > 0) {
        activity.assets = assets
      } else {
        delete activity.assets
      }
      console.log(`[10X RPC] Game spoof: ${activeGame?.slug ?? 'custom'} → application ${spoof.appId} "${spoof.name}"${iconRef ? ' (official icon attached)' : ' (no icon)'}`)
    }
  }

  return activity
}

// Active gateway connections managed in-memory to persist presence and heartbeats
interface GatewayConnection {
  ws: WebSocket
  heartbeatTimer?: NodeJS.Timeout
  platform?: string
  lastStatus?: string
  lastActivities?: object[]
}

declare global {
  var __discordGatewaySockets: Map<string, GatewayConnection> | undefined
}
const gatewaySockets = global.__discordGatewaySockets ?? new Map<string, GatewayConnection>()
global.__discordGatewaySockets = gatewaySockets

/**
 * Send presence via Discord's Gaming SDK gateway.
 *
 * Uses the Gaming SDK gateway (wss://gateway.gaming-sdk.com/?v=10&encoding=json)
 * which accepts user OAuth2 tokens with the `sdk.social_layer_presence` scope.
 */
export async function sendPresenceViaGateway(
  accessToken: string,
  activityOrActivities: object | object[] | null,
  status: string = 'online',
  platform?: string
): Promise<PresenceResult> {
  const tokenKey = accessToken.slice(-32)
  const isQuest = platform === 'meta_quest' || (Array.isArray(activityOrActivities)
    ? activityOrActivities.some((a: any) => a?.platform === 'meta_quest')
    : (activityOrActivities as Record<string, unknown> | null)?.platform === 'meta_quest')
  const targetPlatform = isQuest ? 'meta_quest' : (platform || 'desktop')

  const activities: object[] = Array.isArray(activityOrActivities)
    ? activityOrActivities
    : activityOrActivities ? [activityOrActivities] : []

  // Defense-in-depth: raw http(s) URLs in assets are silently dropped by
  // Discord — strip them so a failed asset resolution can never degrade the
  // presence into the "image not showing" state.
  const safeActivities = sanitizeActivities(activities as Array<Record<string, unknown>>)

  // If clearing presence
  if (activities.length === 0 && (!status || status === 'offline')) {
    const existing = gatewaySockets.get(tokenKey)
    if (existing) {
      try {
        if (existing.ws.readyState === WebSocket.OPEN) {
          existing.ws.send(JSON.stringify({
            op: 3,
            d: {
              status: 'online',
              activities: [],
              afk: false,
              since: null,
            },
          }))
        }
        clearInterval(existing.heartbeatTimer)
        existing.ws.close()
      } catch {}
      gatewaySockets.delete(tokenKey)
    }
    return {
      ok: true,
      method: 'gateway',
      message: 'Presence cleared on gateway',
      activities: [],
    }
  }

  // If already connected and socket is open
  const existing = gatewaySockets.get(tokenKey)
  if (existing && existing.ws.readyState === WebSocket.OPEN) {
    // If the platform changed (e.g. desktop <-> meta_quest <-> mobile), re-identify
    if (existing.platform !== targetPlatform) {
      clearInterval(existing.heartbeatTimer)
      try { existing.ws.close() } catch {}
      gatewaySockets.delete(tokenKey)
    } else {
      try {
        existing.ws.send(JSON.stringify({
          op: 3,
          d: {
            status,
            activities: safeActivities,
            afk: false,
            since: null,
          },
        }))
        existing.lastStatus = status
        existing.lastActivities = safeActivities
        return {
          ok: true,
          method: 'gateway',
          message: isQuest
            ? 'Meta Quest VR presence active on Discord'
            : 'Presence updated via active gateway connection',
          activities: safeActivities,
          activity: safeActivities[0],
        }
      } catch {
        clearInterval(existing.heartbeatTimer)
        gatewaySockets.delete(tokenKey)
      }
    }
  }

  return new Promise((resolve) => {
    try {
      const gatewayUrl = CONFIG.discord.gatewayUrl
      const ws = new WebSocket(gatewayUrl)
      let heartbeatTimer: NodeJS.Timeout | undefined
      let resolved = false

      const finish = (result: PresenceResult) => {
        if (resolved) return
        resolved = true
        resolve(result)
      }

      // Timeout after 15 seconds
      const timeout = setTimeout(() => {
        clearInterval(heartbeatTimer)
        try { ws.close() } catch {}
        gatewaySockets.delete(tokenKey)
        finish({
          ok: false,
          method: 'gateway',
          message: 'Gateway connection timed out (15s)',
        })
      }, 15000)

      ws.on('open', () => {})

      ws.on('message', async (data: Buffer | string) => {
        try {
          const raw = typeof data === 'string' ? data : data.toString()
          const payload = JSON.parse(raw)
          const op = payload.op
          const t = payload.t

          if (op === 10) {
            // HELLO — start heartbeats and send IDENTIFY
            const heartbeatInterval = payload.d?.heartbeat_interval || 41250
            heartbeatTimer = setInterval(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ op: 1, d: null }))
              }
            }, heartbeatInterval)

            // Full official-client properties per platform — the platform badge
            // (Active on Mobile / VR headset / console gamepad) is derived from
            // these by Discord's server (see gateway-platform.ts header).
            // capabilities must NEVER be sent (4097 kills the session ~5s after
            // READY).
            const { properties } = buildIdentify(targetPlatform)

            // Raw user tokens must be sent BARE (Bearer is silently ignored by
            // the gateway); OAuth2 tokens use the Bearer scheme.
            const bearerToken = discordAuthValue(accessToken)
            const identify = {
              op: 2,
              d: {
                token: bearerToken,
                properties,
              },
            }
            ws.send(JSON.stringify(identify))
          } else if (op === 0 && t === 'READY') {
            // READY — send OP 3 PRESENCE_UPDATE (do not re-send on SESSIONS_REPLACE to avoid loop)
            clearTimeout(timeout)
            ws.send(JSON.stringify({
              op: 3,
              d: {
                status,
                activities: safeActivities,
                afk: false,
                since: null,
              },
            }))

            gatewaySockets.set(tokenKey, {
              ws,
              heartbeatTimer,
              platform: targetPlatform,
              lastStatus: status,
              lastActivities: safeActivities,
            })

            finish({
              ok: true,
              method: 'gateway',
              message: isQuest
                ? 'Meta Quest VR presence active on Discord'
                : 'Presence sent via Gaming SDK gateway',
              activities: safeActivities,
              activity: safeActivities[0],
            })
          } else if (op === 0 && t === 'PRESENCE_UPDATE') {
            clearTimeout(timeout)
            finish({
              ok: true,
              method: 'gateway',
              message: isQuest
                ? 'Meta Quest VR presence active on Discord'
                : 'Presence confirmed by Discord',
              activities,
              activity: activities[0],
            })
          } else if (op === 7) {
            // Reconnect requested by Discord
            clearTimeout(timeout)
            clearInterval(heartbeatTimer)
            try { ws.close(4000, 'Discord requested reconnect') } catch {}
            gatewaySockets.delete(tokenKey)
          } else if (op === 9) {
            clearTimeout(timeout)
            clearInterval(heartbeatTimer)
            gatewaySockets.delete(tokenKey)
            finish({
              ok: false,
              method: 'gateway',
              message: 'Invalid session — token may be expired or invalid',
            })
          } else if (op === 1) {
            // Server requested heartbeat
            ws.send(JSON.stringify({ op: 1, d: null }))
          }
        } catch {
          // Ignore parse errors
        }
      })

      ws.on('error', (err: Error) => {
        clearTimeout(timeout)
        clearInterval(heartbeatTimer)
        gatewaySockets.delete(tokenKey)
        finish({
          ok: false,
          method: 'gateway',
          message: `Gateway error: ${err.message}`,
        })
      })

      ws.on('close', (code: number, reason: Buffer) => {
        clearTimeout(timeout)
        clearInterval(heartbeatTimer)
        gatewaySockets.delete(tokenKey)
        if (!resolved) {
          let msg = 'Gateway connection closed before READY'
          if (code === 4004) {
            msg = 'Authentication failed — Discord rejected the OAuth2 token. Make sure your app has the sdk.social_layer_presence scope.'
          } else if (code === 4014) {
            msg = 'Disallowed intent(s) — your Discord app may not have the required permissions.'
          } else if (code) {
            const reasonStr = reason.toString()
            msg = `Gateway closed (code ${code}): ${reasonStr || 'no reason given'}`
          }
          finish({
            ok: false,
            method: 'gateway',
            message: msg,
          })
        }
      })
    } catch (e) {
      resolve({
        ok: false,
        method: 'gateway',
        message: `Failed to init gateway: ${e instanceof Error ? e.message : 'unknown'}`,
      })
    }
  })
}

/**
 * Set custom status via Discord REST API (fallback).
 * Note: Discord requires user token for /users/@me/settings.
 * For OAuth2 tokens, Gateway OP 3 is the standard working mechanism.
 */
export async function setCustomStatusViaRest(
  accessToken: string,
  emoji: string | null,
  text: string | null
): Promise<PresenceResult> {
  try {
    const body: Record<string, unknown> = {}
    if (text || emoji) {
      body.custom_status = {
        text: text || '',
        emoji_name: emoji || '',
      }
    } else {
      body.custom_status = null
    }

    const res = await fetch(`${CONFIG.discord.apiBase}/users/@me/settings`, {
      method: 'PATCH',
      headers: {
        'Authorization': discordAuthValue(accessToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      return {
        ok: false,
        method: 'rest',
        message: `REST API ${res.status}: ${txt.slice(0, 200)}`,
      }
    }

    return {
      ok: true,
      method: 'rest',
      message: text ? `Custom status set: ${emoji || ''} ${text}` : 'Custom status cleared',
    }
  } catch (e) {
    return {
      ok: false,
      method: 'rest',
      message: `REST error: ${e instanceof Error ? e.message : 'unknown'}`,
    }
  }
}

/**
 * Set user status via Discord REST API (fallback).
 */
export async function setStatusViaRest(
  accessToken: string,
  status: string
): Promise<PresenceResult> {
  try {
    const res = await fetch(`${CONFIG.discord.apiBase}/users/@me/settings`, {
      method: 'PATCH',
      headers: {
        'Authorization': discordAuthValue(accessToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status }),
    })

    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      return {
        ok: false,
        method: 'rest',
        message: `Status API ${res.status}: ${txt.slice(0, 200)}`,
      }
    }

    return {
      ok: true,
      method: 'rest',
      message: `Status set to ${status}`,
    }
  } catch (e) {
    return {
      ok: false,
      method: 'rest',
      message: `Status error: ${e instanceof Error ? e.message : 'unknown'}`,
    }
  }
}

/**
 * Refresh the Discord access token using the refresh token.
 * Distinguishes a permanently-dead grant (invalid_grant → re-login needed)
 * from a transient failure (network / 5xx / 429 → retry later, never clear).
 */
export interface DiscordTokenRefreshResult {
  ok: boolean
  /**
   * true  → the refresh grant is DEFINITIVELY dead (Discord answered 4xx
   *         invalid_grant). Only a fresh login helps; the stored tokens must
   *         be cleared so the site prompts "Reconnect Discord".
   * false → transient failure (network error, Discord 5xx / 429). The stored
   *         tokens are still potentially valid — retry later, NEVER clear.
   */
  permanent: boolean
  access_token?: string
  refresh_token?: string
  expires_in?: number
}

export async function refreshDiscordToken(
  refreshToken: string
): Promise<DiscordTokenRefreshResult> {
  try {
    const body = new URLSearchParams({
      client_id: CONFIG.discord.clientId,
      client_secret: CONFIG.discord.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    })
    const res = await fetch(CONFIG.discord.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (res.ok) {
      const data = await res.json() as { access_token: string; refresh_token: string; expires_in: number }
      return { ok: true, permanent: false, ...data }
    }
    // Discord answered with an error status:
    //  • 4xx (except 429) = the grant itself is dead (invalid_grant, bad client)
    //  • 429 / 5xx        = transient (rate limit / Discord outage) — retryable
    const permanent = res.status >= 400 && res.status < 500 && res.status !== 429
    return { ok: false, permanent }
  } catch {
    // Network failure — never treat as a dead token.
    return { ok: false, permanent: false }
  }
}

/**
 * Full presence update pipeline:
 * 1. Get the user's Discord access token (refresh if expired)
 * 2. Build complete activities (Custom Status + Rich Presence) + resolve placeholders
 * 3. Send presence via gateway (OP 3)
 * 4. Update session state in DB
 */
export async function applyPresence(
  session: {
    id: string
    userId: string
    discordAccessToken: string | null
    discordRefreshToken: string | null
    discordTokenExpiresAt: Date | null
    userStatus: string
    customStatus: string | null
    customStatusEmoji: string | null
    vrStatusActive?: boolean
  },
  rpcConfig: RpcConfig | null,
  placeholderCtx: PlaceholderContext
): Promise<PresenceResult> {
  if (!session.discordAccessToken) {
    return {
      ok: false,
      method: 'none',
      message: 'No Discord access token. Please sign in with Discord (not demo mode).',
    }
  }

  let accessToken = session.discordAccessToken
  const now = new Date()
  if (session.discordTokenExpiresAt && session.discordTokenExpiresAt < now) {
    if (session.discordRefreshToken) {
      const refreshed = await refreshDiscordToken(session.discordRefreshToken)
      if (refreshed.ok && refreshed.access_token) {
        accessToken = refreshed.access_token
        const { db } = await import('./db')
        await db.session.update({
          where: { id: session.id },
          data: {
            discordAccessToken: refreshed.access_token,
            discordRefreshToken: refreshed.refresh_token,
            discordTokenExpiresAt: new Date(Date.now() + (refreshed.expires_in || 604800) * 1000),
          },
        })
      } else if (refreshed.permanent) {
        // The refresh grant is dead — clear the stored tokens so the site
        // surfaces the "Reconnect Discord" banner and stops pretending.
        const { db } = await import('./db')
        await db.session.update({
          where: { id: session.id },
          data: {
            discordAccessToken: null,
            discordRefreshToken: null,
            discordTokenExpiresAt: null,
            gatewayReady: false,
          },
        }).catch(() => {})
        return {
          ok: false,
          method: 'none',
          message: 'Discord connection expired. Please reconnect with Discord.',
        }
      } else {
        // Transient refresh failure — the token may still be accepted.
        return {
          ok: false,
          method: 'none',
          message: 'Discord token refresh failed (temporary). Retrying automatically.',
        }
      }
    } else {
      // Expired token with no refresh token (legacy login) — clear & prompt.
      const { db } = await import('./db')
      await db.session.update({
        where: { id: session.id },
        data: {
          discordAccessToken: null,
          discordRefreshToken: null,
          discordTokenExpiresAt: null,
          gatewayReady: false,
        },
      }).catch(() => {})
      return {
        ok: false,
        method: 'none',
        message: 'Discord token expired. Please reconnect with Discord.',
      }
    }
  }

  // MULTI-RPC — collect ALL enabled candidates (up to 3 slots + isolated game)
  // and build one activity per candidate. Auto Rotate settings are applied by
  // the daemon; this path (used by direct callers) sends the simultaneous set.
  let rpcConfigs: Array<RpcConfig & { slot?: number }> = []
  let enabledGame: (RpcConfig & { gameSlug?: string; gameName?: string }) | null = null
  try {
    const { db } = await import('./db')
    const { ensureRpcConfiguredColumn, visibleRpcRows } = await import('./rpc-configured')
    await ensureRpcConfiguredColumn().catch(() => false)
    const [rows, game] = await Promise.all([
      // createdAt order only — never orderBy `slot` (this file also runs on
      // the standalone Orihost daemon, whose Prisma client may predate it).
      db.rpcConfig.findMany({ where: { userId: session.userId }, orderBy: { createdAt: 'asc' } }) as unknown as Promise<Array<RpcConfig & { slot?: number }>>,
      db.gameConfig.findFirst({ where: { userId: session.userId, enabled: true } }),
    ])
    // Task 111 — unconfigured placeholder rows never reach the runtime.
    rpcConfigs = visibleRpcRows(rows ?? [])
    enabledGame = game
  } catch {
    // DB hiccup: fall back to the passed-in single config (legacy behavior).
    if (rpcConfig) rpcConfigs = [rpcConfig]
  }
  const selection = selectActiveRpcConfigs((session as any).rpcEnabled, rpcConfigs, enabledGame)
  const isRpcActive = selection.active
  const isStatusActive = !!(session as any).statusEnabled
  const firstCandidate = selection.candidates[0] ?? null
  const statusPlatform = (session as any).statusPlatform || 'mobile'
  const explicitPlatform = isRpcActive ? (firstCandidate?.platform || 'desktop') : statusPlatform
  // VR unification — honor vrStatusActive even if statusPlatform drifted
  // (mirrors the daemon's connectUserSocket/pushPresenceForUser logic so the
  // IDENTIFY properties and the OP 3 payload always agree).
  const isVr = (isStatusActive && (statusPlatform === 'meta_quest' || !!(session as any).vrStatusActive)) || (isRpcActive && firstCandidate?.platform === 'meta_quest')

  // The GAME candidates (isolated Game RPCs, Task 89 multi-game) may each
  // carry a custom Application ID ("Add Games") — resolve every one of them.
  const gameCandidates = selection.candidates.filter(c => c.gameSlug)
  for (const gc of gameCandidates) {
    gc.gameAppId = await fetchGameAppId(session.userId, gc.gameSlug)
  }

  // Per-row Application ID fallbacks (pre-appId Prisma clients).
  const rpcAppIdMap = await fetchRpcAppIds(session.userId)

  // Build combined activities (custom status + one per candidate).
  // Normal slots resolve to the user's custom Application ID or the 10X RPC
  // application (Task 85 — no game-id shell overlay; Discord renders one card
  // per (platform class, application id) pair and every simultaneous session
  // already gets a DISTINCT platform class).
  const activities = await buildPresenceActivities({
    rpcConfigs: isRpcActive ? selection.candidates : [],
    customStatus: isStatusActive ? session.customStatus : null,
    customStatusEmoji: isStatusActive ? session.customStatusEmoji : null,
    placeholderCtx,
    vrStatusActive: isVr,
    platform: isVr ? 'meta_quest' : explicitPlatform,
    userAccessToken: accessToken,
    rpcAppIdMap,
  })

  // Send presence via Gaming SDK gateway
  const gatewayResult = await sendPresenceViaGateway(
    accessToken,
    activities,
    isStatusActive ? (session.userStatus || 'online') : (isRpcActive ? 'online' : 'invisible'),
    isVr ? 'meta_quest' : explicitPlatform
  )

  // Update session state in DB
  // IMPORTANT: Never write `rpcEnabled` or `statusEnabled` from a presence send result.
  // The database enable flags are the single source of truth for both features and are
  // owned exclusively by their toggle endpoints (/api/status/toggle, /api/rpc/toggle).
  // A gateway send succeeding/failing must never flip either feature on or off
  // (prevents Status <-> RPC cross-triggering and silent feature deactivation).
  const { db } = await import('./db')
  await db.session.update({
    where: { id: session.id },
    data: {
      gatewayReady: gatewayResult.ok,
      lastPresenceUpdate: new Date(),
    },
  })

  return gatewayResult
}

/**
 * Clear all presence (when RPC is disabled or cleared).
 * Sends an empty activity list via gateway.
 */
export async function clearPresence(
  session: {
    id: string
    discordAccessToken: string | null
    discordRefreshToken: string | null
    discordTokenExpiresAt: Date | null
  }
): Promise<PresenceResult> {
  if (!session.discordAccessToken) {
    return {
      ok: false,
      method: 'none',
      message: 'No Discord access token.',
    }
  }

  const gatewayResult = await sendPresenceViaGateway(
    session.discordAccessToken,
    [],
    'online'
  )

  const { db } = await import('./db')
  await db.session.update({
    where: { id: session.id },
    data: {
      rpcEnabled: false,
      gatewayReady: false,
      lastPresenceUpdate: new Date(),
    },
  })

  return gatewayResult
}
