// 10X RPC — Real Discord RPC Manager
// Connects to Discord's Gaming SDK gateway, identifies with the user's OAuth token,
// and sends PRESENCE_UPDATE (op-3) to set the user's rich presence activity and custom status.

import WebSocket from 'ws'
import { CONFIG } from './config'
import type { RpcConfig } from './api-client'
import type { PlaceholderContext } from './placeholders'
import { resolvePlaceholders } from './placeholders'
import { resolveRpcActivityName } from './constants'
import { GAME_SPOOF, findGame, DISCORD_APP_ID_RE } from './games'
import { resolveAssetRef, resolveExternalAsset, sanitizeActivities, type ResolveOpts } from './discord-assets'
import { discordAuthValue } from './discord-auth'

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
  const assets: Record<string, string> = {}
  const largeImageRef = await resolveAssetRef(cfg.largeImage, assetOpts)
  const smallImageRef = await resolveAssetRef(cfg.smallImage, assetOpts)
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

  // Application ID — required for Discord to accept the activity
  // Use the Discord client ID as the application ID
  activity.application_id = CONFIG.discord.clientId

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
// NORMAL RPC vs GAMER (GAME) RPC — MODE SELECTION
//
// The two RPC modes are COMPLETELY SEPARATE configurations:
//   • Normal RPC  → RpcConfig row  (user's custom Rich Presence)
//   • Gamer RPC   → GameConfig row (enabled game preset, spoofed as real app)
//
// Neither mode ever reads, copies, merges or overwrites the other's data.
// Exactly ONE mode may be active at a time — every write path enforces this
// (enabling one auto-disables the other's enabled flag; field data of both
// configurations is preserved so switching modes never resets anything).
//
// The active mode is derived transactionally from the enabled flags:
//   • an enabled GameConfig  → GAME mode wins
//   • else RpcConfig.enabled → NORMAL mode
// (game precedence is purely defensive against legacy rows where both were
// left enabled — new writes can never produce that state).
// ════════════════════════════════════════════════════════════════════════

export type RpcMode = 'normal' | 'game'

export interface ActiveRpcSelection {
  /** Master RPC flag ON and the active mode's own config is enabled. */
  active: boolean
  /** Which mode owns the presence right now (null = nothing active). */
  mode: RpcMode | null
  /**
   * Config of the ACTIVE mode only — an RpcConfig row in normal mode, or a
   * synthesized activity config from the enabled GameConfig row in game mode.
   * Never a merge of the two.
   */
  config: RpcConfig | null
  /** Enabled game slug in game mode (drives official-app spoofing); else null. */
  gameSlug: string | null
}

/**
 * Pick the single active RPC mode + its own config.
 * GameConfig rows carry `gameName` (not `name`) and no `type` — the synthesized
 * game-mode config normalizes both so downstream activity building is uniform.
 */
export function selectActiveRpc(
  rpcEnabled: boolean | null | undefined,
  rpcConfig: RpcConfig | null | undefined,
  enabledGame: (RpcConfig & { gameSlug?: string; gameName?: string }) | null | undefined
): ActiveRpcSelection {
  // GAMER RPC — an enabled game owns the presence exclusively.
  // (Defensive: also verifies the row's own enabled flag, so passing an
  // unfiltered GameConfig row can never activate a disabled game.)
  if (enabledGame && enabledGame.enabled !== false) {
    const gameName = (enabledGame as { gameName?: string }).gameName || enabledGame.name || 'Game'
    return {
      active: !!rpcEnabled,
      mode: 'game',
      config: {
        ...enabledGame,
        name: gameName,
        type: 'PLAYING',
        enabled: true,
      },
      gameSlug: (enabledGame as { gameSlug?: string }).gameSlug ?? null,
    }
  }

  // NORMAL RPC — user's own Rich Presence config (only when its own enabled flag is set).
  if (rpcConfig && rpcConfig.enabled) {
    return {
      active: !!rpcEnabled,
      mode: 'normal',
      config: rpcConfig,
      gameSlug: null,
    }
  }

  return { active: false, mode: null, config: null, gameSlug: null }
}

/**
 * Build the full activities array for Discord Gateway OP 3.
 * Supports both Custom Status (type 4) AND Rich Presence Game/App Activity (type 0..5) simultaneously.
 */
export async function buildPresenceActivities(options: {
  rpcConfig?: RpcConfig | null
  customStatus?: string | null
  customStatusEmoji?: string | null
  placeholderCtx?: PlaceholderContext
  vrStatusActive?: boolean
  platform?: string
  /** User OAuth token — enables external-asset resolution (animated GIFs). */
  userAccessToken?: string | null
  /** The user's ENABLED game slug (GameConfig.enabled) — enables game spoofing. */
  selectedGameSlug?: string | null
  /** Discord Application ID for CUSTOM games ("Add Games") — spoofs that application. */
  selectedGameAppId?: string | null
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

  // 2. Rich Presence activity (type 0, etc.)
  const explicitPlatform = options.platform || options.rpcConfig?.platform
  const isVr = explicitPlatform === 'meta_quest' || (!!options.vrStatusActive && (!explicitPlatform || explicitPlatform === 'meta_quest'))

  if (options.rpcConfig && options.rpcConfig.enabled !== false) {
    const ctx = options.placeholderCtx || {
      timezone: 'UTC',
      rpcStartedAt: Date.now(),
    }
    const rpcActivity = (await buildActivityPayload(options.rpcConfig, ctx, {
      userAccessToken: options.userAccessToken,
    })) as Record<string, unknown>
    if (isVr) {
      rpcActivity.platform = 'meta_quest'
      if (!rpcActivity.state) {
        rpcActivity.state = 'In Virtual Reality'
      }
    }
    // Activity Name is ALWAYS prioritized from custom NAME, falling back to platform name only when NAME is empty.
    rpcActivity.name = resolveRpcActivityName(options.rpcConfig?.name, isVr ? 'meta_quest' : explicitPlatform)

    // Game spoof — when the user's ENABLED game has a known real Discord
    // application identity AND the active RPC is that game (name matches the
    // preset), present the activity as the game's OFFICIAL application:
    // real application_id + official display name + official app icon —
    // exactly like the real game's own Rich Presence.
    const activeGame = options.selectedGameSlug ? findGame(options.selectedGameSlug) : undefined
    let spoof: GameSpoofEntry | undefined
      = activeGame && options.rpcConfig?.name === activeGame.name ? GAME_SPOOF[activeGame.slug] : undefined
    if (!spoof && options.selectedGameAppId && options.rpcConfig?.name) {
      // CUSTOM game ("Add Games") with a user-supplied Discord Application ID:
      // present the presence as that application. The stored config name is the
      // application's official name (validated & auto-filled from Discord at
      // save time); the icon rides the config's own image URL, resolved to an
      // app-independent mp:external reference below.
      const cfgIcon = options.rpcConfig.largeImage
      spoof = {
        appId: options.selectedGameAppId,
        name: options.rpcConfig.name,
        icon: cfgIcon && /^https?:\/\//i.test(cfgIcon) ? cfgIcon : '',
      }
    }
    if (spoof) {
      rpcActivity.application_id = spoof.appId
      rpcActivity.name = spoof.name
      const assets = (rpcActivity.assets as Record<string, string> | undefined) ?? {}
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
        rpcActivity.assets = assets
      } else {
        delete rpcActivity.assets
      }
      console.log(`[10X RPC] Game spoof: ${activeGame?.slug ?? 'custom'} → application ${spoof.appId} "${spoof.name}"${iconRef ? ' (official icon attached)' : ' (no icon)'}`)
    }
    activities.push(rpcActivity)
  }

  return activities
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

            const isMobile = targetPlatform === 'android' || targetPlatform === 'ios' || targetPlatform === 'samsung' || targetPlatform === 'mobile'
            const isConsole = targetPlatform === 'console' || targetPlatform === 'xbox' || targetPlatform === 'ps4' || targetPlatform === 'ps5'
            const isWeb = targetPlatform === 'web'

            const properties = isQuest
              ? {
                  os: 'Android',
                  browser: 'Discord VR',
                  device: 'Meta Quest',
                }
              : isMobile
              ? {
                  os: targetPlatform === 'ios' ? 'iOS' : 'Android',
                  browser: targetPlatform === 'ios' ? 'Discord iOS' : 'Discord Android',
                  device: targetPlatform === 'ios' ? 'iPhone' : (targetPlatform === 'samsung' ? 'Samsung Galaxy' : 'Android Device'),
                }
              : isConsole
              ? {
                  os: targetPlatform === 'xbox' ? 'Xbox' : 'PlayStation',
                  browser: targetPlatform === 'xbox' ? 'Discord Xbox' : 'Discord PlayStation',
                  device: targetPlatform === 'xbox' ? 'Xbox Series X' : 'PlayStation 5',
                }
              : isWeb
              ? {
                  os: 'Windows',
                  browser: 'Discord Web',
                  device: 'Chrome',
                }
              : {
                  os: 'Windows',
                  browser: 'Discord Client',
                  device: 'Desktop',
                }

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

  // MUTUAL EXCLUSIVITY — pick the ONE active mode and use ONLY its config:
  // game mode (enabled GameConfig) and normal mode (RpcConfig.enabled) never
  // combine. selectActiveRpc returns the active mode's own config, or null.
  let enabledGame: (RpcConfig & { gameSlug?: string; gameName?: string }) | null = null
  try {
    const { db } = await import('./db')
    enabledGame = await db.gameConfig.findFirst({ where: { userId: session.userId, enabled: true } })
  } catch {
    enabledGame = null
  }
  const selection = selectActiveRpc((session as any).rpcEnabled, rpcConfig, enabledGame)
  const isRpcActive = selection.active
  const isStatusActive = !!(session as any).statusEnabled
  const statusPlatform = (session as any).statusPlatform || 'mobile'
  const explicitPlatform = isRpcActive ? (selection.config?.platform || 'desktop') : statusPlatform
  const isVr = (isStatusActive && statusPlatform === 'meta_quest') || (isRpcActive && selection.config?.platform === 'meta_quest')

  // Custom games may carry a Discord Application ID — spoof that application.
  const selectedGameAppId = isRpcActive && selection.mode === 'game'
    ? await fetchGameAppId(session.userId, selection.gameSlug)
    : null

  // Build combined activities (custom status + rich presence)
  const activities = await buildPresenceActivities({
    rpcConfig: isRpcActive ? selection.config : null,
    customStatus: isStatusActive ? session.customStatus : null,
    customStatusEmoji: isStatusActive ? session.customStatusEmoji : null,
    placeholderCtx,
    vrStatusActive: isVr,
    platform: isVr ? 'meta_quest' : explicitPlatform,
    userAccessToken: accessToken,
    // Only the GAME mode's own game drives official-app spoofing.
    selectedGameSlug: isRpcActive && selection.mode === 'game' ? selection.gameSlug : null,
    selectedGameAppId,
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
