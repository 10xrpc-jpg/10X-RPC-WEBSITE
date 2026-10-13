// 10X RPC — Real Discord RPC Manager
// Connects to Discord's Gaming SDK gateway, identifies with the user's OAuth token,
// and sends PRESENCE_UPDATE (op-3) to set the user's rich presence activity and custom status.

import WebSocket from 'ws'
import { CONFIG } from './config'
import type { RpcConfig } from './api-client'
import type { PlaceholderContext } from './placeholders'
import { resolvePlaceholders } from './placeholders'
import { resolveRpcActivityName } from './constants'
import { GAME_SPOOF, findGame, DISCORD_APP_ID_RE, type GameSpoofEntry } from './games'
import { resolveAssetRef, resolveExternalAsset, sanitizeActivities, type ResolveOpts } from './discord-assets'
import { discordAuthValue } from './discord-auth'
import { buildIdentify } from './gateway-platform'

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
      if (r.appId && DISCORD_APP_ID_RE.test(r.appId)) map.set(r.id, r.appId)
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
  const customAppId = cfg.appId && DISCORD_APP_ID_RE.test(cfg.appId) ? cfg.appId : null
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

  // Application ID — required for Discord to accept the activity.
  // A user-supplied Application ID presents the presence as THEIR application
  // (their own Discord app from the Developer Portal); otherwise the 10X app
  // identity is used.
  activity.application_id = customAppId || CONFIG.discord.clientId

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
   * Enabled RpcConfig slots (slot order) + the synthesized enabled game config
   * appended LAST. Never a merge across slots.
   */
  candidates: RpcCandidate[]
}

/**
 * Collect the enabled candidates. Each slot's own `enabled` flag is the ONLY
 * thing that decides inclusion; the game candidate keeps its own flag too.
 */
export function selectActiveRpcConfigs(
  rpcEnabled: boolean | null | undefined,
  rpcConfigs: Array<RpcConfig & { slot?: number }> | null | undefined,
  enabledGame: (RpcConfig & { gameSlug?: string; gameName?: string }) | null | undefined
): MultiRpcSelection {
  const candidates: RpcCandidate[] = []
  const slots = (rpcConfigs ?? [])
    .filter(c => c.enabled)
    .slice()
    .sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99))
  candidates.push(...slots)

  // GAME RPC — synthesized config appended last (isolated from the slots).
  // (Defensive: also verifies the row's own enabled flag, so passing an
  // unfiltered GameConfig row can never activate a disabled game.)
  if (enabledGame && enabledGame.enabled !== false) {
    const gameName = (enabledGame as { gameName?: string }).gameName || enabledGame.name || 'Game'
    candidates.push({
      ...enabledGame,
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
  /** 0-based index into the FULL candidate list while rotating (else null). */
  rotateIndex: number | null
}

/**
 * Resolve which candidates are PUBLISHED right now.
 *
 * Auto Rotate (optional): picks exactly one candidate, deterministically, by
 * elapsed time from a stable reference — index = floor(elapsed / secs) % N.
 * Stateless across daemon restarts/multi-instance (same inputs → same index).
 * Auto Rotate is a RUNTIME-ONLY overlay: it never writes configs, never flips
 * enabled flags, never touches Game RPC settings, app IDs, buttons, images or
 * timestamps.
 */
export function resolveRuntimeCandidates(opts: {
  rpcEnabled: boolean | null | undefined
  rpcConfigs: Array<RpcConfig & { slot?: number }> | null | undefined
  enabledGame: (RpcConfig & { gameSlug?: string; gameName?: string }) | null | undefined
  autoRotate?: boolean | null
  rotateSecs?: number | null
  /** Stable rotation clock anchor (ms epoch) — e.g. rotate settings' updatedAt. */
  rotateRefMs?: number | null
  nowMs?: number
}): RuntimeCandidateResult {
  const sel = selectActiveRpcConfigs(opts.rpcEnabled, opts.rpcConfigs, opts.enabledGame)
  if (!sel.active) {
    return { ...sel, runtimeMode: 'simultaneous', rotateIndex: null }
  }
  if (sel.candidates.length === 1) {
    return { ...sel, runtimeMode: 'single', rotateIndex: null }
  }
  if (!opts.autoRotate) {
    return { ...sel, runtimeMode: 'simultaneous', rotateIndex: null }
  }
  const secs = Math.max(15, Math.min(3600, Math.floor(Number(opts.rotateSecs ?? 30)) || 30))
  const nowMs = opts.nowMs ?? Date.now()
  const ref = opts.rotateRefMs && !isNaN(opts.rotateRefMs) && opts.rotateRefMs <= nowMs ? opts.rotateRefMs : nowMs
  const elapsed = Math.max(0, Math.floor((nowMs - ref) / 1000))
  const idx = Math.floor(elapsed / secs) % sel.candidates.length
  return {
    active: true,
    candidates: [sel.candidates[idx]],
    runtimeMode: 'rotate',
    rotateIndex: idx,
  }
}

// ════════════════════════════════════════════════════════════════════════════
// APPLICATION-ID DE-COLLISION (Task 84 — "show 3 RPCs at the same time")
// Discord renders ONE activity card per unique Application ID: simultaneous
// candidates that resolve to the same application (every slot with no custom
// Application ID defaults to the 10X app) are collapsed by the client into a
// single card — live-verified (3 same-app sessions → 1 card, while the
// distinct-app Game RPC rendered its own card next to it).
// In simultaneous mode every duplicate candidate therefore receives a
// DISTINCT "shell" Application ID: a real, public Discord application
// identity (from the GAME_SPOOF catalog). RUNTIME-ONLY overlay — saved
// configs are never modified, card content (name/details/state/buttons/
// timestamps) is untouched, and externally mirrored images (mp:external/…)
// render identically under ANY application id, so cards keep their branding.
// The assignment is deterministic (candidate order + pool order) so daemon
// restarts and multi-instance runs always compute the same identities, and
// enabling/disabling the Game RPC can never reshuffle slot identities
// (game ids are reserved first).
// ════════════════════════════════════════════════════════════════════════════

/** Deterministic shell pool — real public application IDs (GAME_SPOOF order). */
export const RPC_SHELL_APPLICATION_IDS: string[] = Array.from(
  new Set(Object.values(GAME_SPOOF).map(e => e.appId))
)

/** Candidate map key — stable, mirrors the daemon's slot-session key. */
function rpcCandidateKey(cfg: RpcCandidate): string {
  return cfg.id || (cfg.gameSlug ? `game:${cfg.gameSlug}` : '')
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
  if (cfg.appId && DISCORD_APP_ID_RE.test(cfg.appId)) return cfg.appId
  const fallback = cfg.id && rpcAppIdMap ? rpcAppIdMap.get(cfg.id) : null
  if (fallback && DISCORD_APP_ID_RE.test(fallback)) return fallback
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
  /**
   * Runtime Application-ID de-collision (assignCandidateApplicationIds) —
   * simultaneous mode assigns every duplicate application a distinct shell
   * id so Discord renders one card PER RPC. Keyed by rpcCandidateKey(cfg).
   */
  appIdOverrides?: Map<string, string> | null
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
    appIdOverrides?: Map<string, string> | null
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
  if (!cfg.gameSlug && fallbackAppId && !DISCORD_APP_ID_RE.test(cfgForBuild.appId || '')) {
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

  // Application-ID de-collision — the simultaneous-mode override (computed by
  // assignCandidateApplicationIds) has the FINAL say so every duplicate
  // application renders as its own card. Game candidates are never overridden
  // (their official id is reserved first).
  const overrideKey = cfg.id || (cfg.gameSlug ? `game:${cfg.gameSlug}` : '')
  const appIdOverride = overrideKey ? options.appIdOverrides?.get(overrideKey) : null
  if (appIdOverride && DISCORD_APP_ID_RE.test(appIdOverride)) {
    activity.application_id = appIdOverride
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
    const [rows, game] = await Promise.all([
      // createdAt order only — never orderBy `slot` (this file also runs on
      // the standalone Orihost daemon, whose Prisma client may predate it).
      db.rpcConfig.findMany({ where: { userId: session.userId }, orderBy: { createdAt: 'asc' } }) as unknown as Promise<Array<RpcConfig & { slot?: number }>>,
      db.gameConfig.findFirst({ where: { userId: session.userId, enabled: true } }),
    ])
    rpcConfigs = rows ?? []
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

  // The GAME candidate carries its slug; resolve its custom Application ID
  // ("Add Games") so the activity can present as that application.
  const gameCandidate = selection.candidates.find(c => c.gameSlug)
  if (gameCandidate) {
    gameCandidate.gameAppId = await fetchGameAppId(session.userId, gameCandidate.gameSlug)
  }

  // Per-row Application ID fallbacks (pre-appId Prisma clients).
  const rpcAppIdMap = await fetchRpcAppIds(session.userId)

  // Simultaneous multi-RPC: de-collide Application IDs so Discord renders
  // one card PER RPC (same deterministic rule as the daemon's Multi-Session).
  const appIdOverrides = isRpcActive && selection.candidates.length >= 2
    ? assignCandidateApplicationIds(selection.candidates, { rpcAppIdMap })
    : null

  // Build combined activities (custom status + one per candidate)
  const activities = await buildPresenceActivities({
    rpcConfigs: isRpcActive ? selection.candidates : [],
    customStatus: isStatusActive ? session.customStatus : null,
    customStatusEmoji: isStatusActive ? session.customStatusEmoji : null,
    placeholderCtx,
    vrStatusActive: isVr,
    platform: isVr ? 'meta_quest' : explicitPlatform,
    userAccessToken: accessToken,
    rpcAppIdMap,
    appIdOverrides,
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
