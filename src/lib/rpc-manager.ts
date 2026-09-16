// 10X RPC — Real Discord RPC Manager
// Connects to Discord's Gaming SDK gateway, identifies with the user's OAuth token,
// and sends PRESENCE_UPDATE (op-3) to set the user's rich presence activity.
//
// Also supports REST-based custom status updates via PATCH /users/@me/settings.

import WebSocket from 'ws'
import { CONFIG } from './config'
import type { RpcConfig } from './api-client'
import type { PlaceholderContext } from './placeholders'
import { resolvePlaceholders } from './placeholders'

// Activity types mapped to Discord's numeric values
const ACTIVITY_TYPE_MAP: Record<string, number> = {
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
  activity?: object
}

/**
 * Build a Discord activity payload from the user's RPC config.
 * Resolves dynamic placeholders in state/details using the placeholder engine.
 */
export async function buildActivityPayload(
  cfg: RpcConfig,
  placeholderCtx: PlaceholderContext
): Promise<object> {
  const state = await resolvePlaceholders(cfg.state || '', placeholderCtx)
  const details = await resolvePlaceholders(cfg.details || '', placeholderCtx)
  const type = ACTIVITY_TYPE_MAP[cfg.type || 'PLAYING'] ?? 0

  const activity: Record<string, unknown> = {
    type,
    name: cfg.name || '10X RPC',
  }

  if (state) activity.state = state
  if (details) activity.details = details

  // URLs
  if (cfg.url) activity.url = cfg.url

  // Timestamps — use Unix seconds
  const now = Date.now()
  if (cfg.startMinsAgo != null && cfg.startMinsAgo >= 0) {
    activity.timestamps = {
      start: Math.floor((now - cfg.startMinsAgo * 60 * 1000) / 1000),
    }
  }
  if (cfg.endTotalMins != null && cfg.endTotalMins > 0) {
    const startMs = now - (cfg.startMinsAgo || 0) * 60 * 1000
    const endMs = startMs + cfg.endTotalMins * 60 * 1000
    activity.timestamps = {
      ...(activity.timestamps as object),
      end: Math.floor(endMs / 1000),
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
  const assets: Record<string, string> = {}
  if (cfg.largeImage) assets.large_image = cfg.largeImage
  if (cfg.largeText) assets.large_text = cfg.largeText
  if (cfg.smallImage) assets.small_image = cfg.smallImage
  if (cfg.smallText) assets.small_text = cfg.smallText
  if (Object.keys(assets).length > 0) activity.assets = assets

  // Buttons (max 2)
  const buttons: Array<{ label: string; url: string }> = []
  if (cfg.button1Label && cfg.button1Url) {
    buttons.push({ label: cfg.button1Label, url: cfg.button1Url })
  }
  if (cfg.button2Label && cfg.button2Url) {
    buttons.push({ label: cfg.button2Label, url: cfg.button2Url })
  }
  if (buttons.length > 0) activity.buttons = buttons

  // Platform — send-side field for headless/embedded sessions
  if (cfg.platform) activity.platform = cfg.platform

  // Application ID — required for Discord to accept the activity
  // Use the Discord client ID as the application ID
  activity.application_id = CONFIG.discord.clientId

  return activity
}

/**
 * Connect to Discord's Gaming SDK gateway and send a PRESENCE_UPDATE.
 * This is a short-lived connection: connect → identify → send presence → close.
 *
 * The Gaming SDK gateway URL is wss://gateway.gaming-sdk.com/?encoding=json&v=10
 */
export async function sendPresenceViaGateway(
  accessToken: string,
  activity: object | null,
  status: string = 'online'
): Promise<PresenceResult> {
  return new Promise((resolve) => {
    try {
      // Use the Gaming SDK gateway URL directly (already includes ?v=10&encoding=json)
      const gatewayUrl = CONFIG.discord.gatewayUrl
      const ws = new WebSocket(gatewayUrl)

      let resolved = false
      const finish = (result: PresenceResult) => {
        if (resolved) return
        resolved = true
        try { ws.close() } catch {}
        resolve(result)
      }

      // Timeout after 15 seconds
      const timeout = setTimeout(() => {
        finish({
          ok: false,
          method: 'gateway',
          message: 'Gateway connection timed out (15s)',
        })
      }, 15000)

      ws.on('open', () => {
        // Wait for HELLO (op 10) which contains heartbeat_interval
      })

      ws.on('message', async (data: Buffer | string) => {
        try {
          const raw = typeof data === 'string' ? data : data.toString()
          const payload = JSON.parse(raw)
          const op = payload.op
          const t = payload.t

          if (op === 10) {
            // HELLO — send IDENTIFY
            // For OAuth2 user tokens, do NOT include `intents` — it's only for bot tokens
            const identify = {
              op: 2,
              d: {
                token: accessToken,
                properties: {
                  os: 'linux',
                  browser: '10X RPC',
                  device: '10X RPC',
                },
                presence: {
                  status,
                  activities: activity ? [activity] : [],
                  afk: false,
                  since: null,
                },
              },
            }
            ws.send(JSON.stringify(identify))
          } else if (op === 0 && t === 'READY') {
            // READY — we're connected and identified. Presence was sent with IDENTIFY.
            clearTimeout(timeout)
            finish({
              ok: true,
              method: 'gateway',
              message: 'Presence sent via Gaming SDK gateway',
              activity,
            })
          } else if (op === 0 && t === 'PRESENCE_UPDATE') {
            // Server confirmed our presence update
            clearTimeout(timeout)
            finish({
              ok: true,
              method: 'gateway',
              message: 'Presence confirmed by Discord',
              activity,
            })
          } else if (op === 0 && t === 'USER_SETTINGS_UPDATE') {
            // Settings updated (custom status)
          } else if (op === 9) {
            // Invalid session
            clearTimeout(timeout)
            finish({
              ok: false,
              method: 'gateway',
              message: 'Invalid session — token may be expired or invalid',
            })
          } else if (op === 1) {
            // Heartbeat — send heartbeat back
            ws.send(JSON.stringify({ op: 1, d: null }))
          }
        } catch (e) {
          // Ignore parse errors
        }
      })

      ws.on('error', (err: Error) => {
        clearTimeout(timeout)
        finish({
          ok: false,
          method: 'gateway',
          message: `Gateway error: ${err.message}`,
        })
      })

      ws.on('close', (code: number, reason: Buffer) => {
        clearTimeout(timeout)
        if (!resolved) {
          let msg = 'Gateway connection closed before READY'
          // Discord close codes:
          // 4004 = Authentication failed (bad token)
          // 4014 = Disallowed intent(s)
          // 4000 = Unknown error
          // 4001 = Unknown opcode
          // 4003 = Not authenticated
          // 4007 = Invalid seq
          // 4008 = Rate limited
          // 4009 = Session timed out
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
 * Set custom status via Discord REST API.
 * PATCH /api/v9/users/@me/settings with { custom_status: { text, emoji_name } }
 * This works with OAuth2 user tokens that have the `identify` scope.
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
        'Authorization': `Bearer ${accessToken}`,
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
 * Set user status (online/idle/dnd/invisible) via Discord REST API.
 */
export async function setStatusViaRest(
  accessToken: string,
  status: string
): Promise<PresenceResult> {
  try {
    const res = await fetch(`${CONFIG.discord.apiBase}/users/@me/settings`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
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
 * Returns new tokens or null on failure.
 */
export async function refreshDiscordToken(
  refreshToken: string
): Promise<{ access_token: string; refresh_token: string; expires_in: number } | null> {
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
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}

/**
 * Full presence update pipeline:
 * 1. Get the user's Discord access token (refresh if expired)
 * 2. Build the activity payload from RPC config + resolve placeholders
 * 3. Send presence via gateway
 * 4. Also set custom status via REST (if configured)
 * 5. Update session state in DB
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
  },
  rpcConfig: RpcConfig | null,
  placeholderCtx: PlaceholderContext
): Promise<PresenceResult> {
  // Check if we have a Discord access token
  if (!session.discordAccessToken) {
    return {
      ok: false,
      method: 'none',
      message: 'No Discord access token. Please sign in with Discord (not demo mode).',
    }
  }

  // Check if token is expired and refresh if needed
  let accessToken = session.discordAccessToken
  const now = new Date()
  if (session.discordTokenExpiresAt && session.discordTokenExpiresAt < now) {
    if (session.discordRefreshToken) {
      const refreshed = await refreshDiscordToken(session.discordRefreshToken)
      if (refreshed) {
        accessToken = refreshed.access_token
        // Update the session with new tokens
        const { db } = await import('./db')
        await db.session.update({
          where: { id: session.id },
          data: {
            discordAccessToken: refreshed.access_token,
            discordRefreshToken: refreshed.refresh_token,
            discordTokenExpiresAt: new Date(Date.now() + (refreshed.expires_in || 604800) * 1000),
          },
        })
      } else {
        return {
          ok: false,
          method: 'none',
          message: 'Discord token expired and refresh failed. Please sign in again.',
        }
      }
    } else {
      return {
        ok: false,
        method: 'none',
        message: 'Discord token expired. Please sign in again.',
      }
    }
  }

  // Build the activity payload if RPC config exists
  let activity: object | null = null
  if (rpcConfig) {
    activity = await buildActivityPayload(rpcConfig, placeholderCtx)
  }

  // Send presence via Gaming SDK gateway
  const gatewayResult = await sendPresenceViaGateway(
    accessToken,
    activity,
    session.userStatus
  )

  // Always try REST API for custom status + user status (works independently of gateway)
  // Even if the gateway fails, the user status + custom status should still be set
  let restSuccess = false
  let restMessages: string[] = []

  if (session.customStatus || session.customStatusEmoji) {
    const csResult = await setCustomStatusViaRest(
      accessToken,
      session.customStatusEmoji,
      session.customStatus
    )
    if (csResult.ok) restSuccess = true
    else restMessages.push(csResult.message)
  }

  const statusResult = await setStatusViaRest(accessToken, session.userStatus)
  if (statusResult.ok) restSuccess = true
  else restMessages.push(statusResult.message)

  // Determine final result
  // If gateway succeeded → great, full RPC is live
  // If gateway failed but REST succeeded → custom status + user status are set, but no rich presence activity
  // If both failed → error
  let finalResult: PresenceResult
  if (gatewayResult.ok) {
    finalResult = gatewayResult
  } else if (restSuccess) {
    finalResult = {
      ok: true,
      method: 'rest',
      message: `Status + custom status set via REST (gateway failed: ${gatewayResult.message})`,
    }
  } else {
    finalResult = {
      ok: false,
      method: 'none',
      message: `Gateway: ${gatewayResult.message}. REST: ${restMessages.join('; ')}`,
    }
  }

  // Update session state
  const { db } = await import('./db')
  await db.session.update({
    where: { id: session.id },
    data: {
      rpcEnabled: finalResult.ok,
      gatewayReady: gatewayResult.ok,
      lastPresenceUpdate: new Date(),
    },
  })

  return finalResult
}

/**
 * Clear all presence (when RPC is disabled).
 * Sends an empty activity via gateway + clears custom status via REST.
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

  // Send empty presence via gateway
  const gatewayResult = await sendPresenceViaGateway(
    session.discordAccessToken,
    null,
    'online'
  )

  // Clear custom status via REST
  await setCustomStatusViaRest(session.discordAccessToken, null, null)

  // Update session
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
