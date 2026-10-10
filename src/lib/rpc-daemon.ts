// 10X RPC — 24/7 Background RPC & Status Daemon
// Maintains persistent Discord Gateway WebSocket connections for all active sessions,
// automatically recovers from drops, refreshes expired OAuth tokens, ticks status rotator,
// updates dynamic placeholders, and enforces sleep timers.

import WebSocket from 'ws'
import { CONFIG } from './config'
import { db } from './db'
import {
  buildPresenceActivities,
  buildCustomStatusActivity,
  fetchGameAppId,
  refreshDiscordToken,
  selectActiveRpc,
  type PresenceResult,
} from './rpc-manager'
import { resolvePlaceholders, type PlaceholderContext } from './placeholders'
import { sanitizeActivities } from './discord-assets'
import { discordAuthValue } from './discord-auth'

interface ActiveUserSocket {
  userId: string
  sessionId: string
  ws: WebSocket | null
  heartbeatTimer?: NodeJS.Timeout
  heartbeatAck: boolean
  /** Timestamp of the last op-1 heartbeat we sent without an ACK yet. */
  lastHeartbeatSentAt?: number
  retryCount: number
  retryTimer?: NodeJS.Timeout
  platform: string
  lastStatus: string
  lastActivitiesHash: string
  connected: boolean
  lastConnectedAt?: Date
  isConnecting: boolean
  connectingSince?: number
  lastPushAt?: number
  /** Token sent with the last IDENTIFY — lets the close handler remember
   *  exactly which token Discord rejected. */
  identifiedWith?: string | null
  /** The Discord token whose IDENTIFY was rejected with 4004 (Authentication
   *  failed). 4004 means the token ITSELF is dead (revoked/reset) — retrying
   *  the same token hits 4004 forever. Auth stays fatal until the stored
   *  token CHANGES (re-login / new token), which auto-unblocks the user. */
  failedAuthToken?: string | null
}

export class RpcDaemon {
  private sockets = new Map<string, ActiveUserSocket>()
  private tickTimer?: NodeJS.Timeout
  private watchdogTimer?: NodeJS.Timeout
  private isRunning = false
  private startTime = Date.now()
  private lastTickAt: Date | null = null

  /**
   * Start the 24/7 background daemon.
   */
  public async start(): Promise<void> {
    if (this.isRunning) return
    this.isRunning = true
    this.startTime = Date.now()
    console.log('[10X RPC Daemon] Starting 24/7 background daemon...')

    // Run initial sync
    await this.syncAllUsers().catch(err => {
      console.error('[10X RPC Daemon] Initial sync error:', err)
    })

    // Tick every 30 seconds
    this.tickTimer = setInterval(async () => {
      try {
        await this.tick()
      } catch (err) {
        console.error('[10X RPC Daemon] Tick error:', err)
      }
    }, 30000)

    // Watchdog every 60 seconds — 24/7 self-healing:
    // recovers stalled tick loops, stuck/lost connections and silently-dead presence.
    this.watchdogTimer = setInterval(() => {
      this.watchdog().catch(err => {
        console.error('[10X RPC Daemon] Watchdog error:', err)
      })
    }, 60000)

    console.log('[10X RPC Daemon] 24/7 daemon started successfully.')
  }

  /**
   * 24/7 self-healing watchdog. Runs every 60s:
   * 1. Tick-loop stall recovery (tick hasn't run for >90s → force one)
   * 2. Socket stuck in "connecting" for >60s (TCP black hole) → reset & reconnect
   * 3. Socket disconnected with NO reconnect pending → revive the reconnect chain
   * 4. Socket connected but presence not pushed for >10 min → force refresh
   */
  private async watchdog(): Promise<void> {
    const nowMs = Date.now()

    // 1. Stalled tick loop recovery
    if (this.isRunning && this.lastTickAt && nowMs - this.lastTickAt.getTime() > 90000) {
      console.warn('[10X RPC Daemon] Watchdog: tick loop stalled (>90s). Forcing recovery tick...')
      this.lastTickAt = new Date() // prevent re-trigger every 60s while the forced tick runs
      await this.tick().catch(err => {
        console.error('[10X RPC Daemon] Watchdog recovery tick failed:', err)
      })
    }

    // 2-4. Per-socket liveness
    for (const [userId, userSock] of this.sockets.entries()) {
      // 2. Stuck connecting — the WS neither opened nor errored/closed
      if (userSock.isConnecting && userSock.connectingSince && nowMs - userSock.connectingSince > 60000) {
        console.warn(`[10X RPC Daemon] Watchdog: connection for user ${userId} stuck in connecting (>60s). Resetting...`)
        this.cleanupSocket(userSock)
        this.scheduleReconnect(userId, 1000)
        continue
      }

      // 3. Disconnected with no reconnect pending — revive the chain
      if (!userSock.connected && !userSock.isConnecting && !userSock.retryTimer) {
        // Auth-fatal (4004) users stay down until their token changes —
        // syncAllUsers unblocks them automatically once a new token lands.
        if (userSock.failedAuthToken) continue
        console.warn(`[10X RPC Daemon] Watchdog: user ${userId} disconnected with no reconnect pending. Reviving...`)
        this.scheduleReconnect(userId, 1000)
        continue
      }

      // 4. Connected but presence not pushed for >10 min — force refresh
      if (userSock.connected && userSock.ws && userSock.ws.readyState === WebSocket.OPEN) {
        const pushAge = userSock.lastPushAt ? nowMs - userSock.lastPushAt : Infinity
        if (pushAge > 10 * 60 * 1000) {
          console.log(`[10X RPC Daemon] Watchdog: forcing presence refresh for user ${userId} (last push ${Math.round(pushAge / 1000)}s ago)`)
          try {
            // Same filtered query as connectUserSocket — never push presence
            // on behalf of an expired/tokenless session.
            const session = await db.session.findFirst({
              where: {
                userId,
                expiresAt: { gt: new Date() },
                discordAccessToken: { not: null },
              },
              orderBy: { createdAt: 'desc' },
            })
            if (session) {
              await this.pushPresenceForUser(userId, session, true)
            }
          } catch (err) {
            console.error(`[10X RPC Daemon] Watchdog presence refresh failed for user ${userId}:`, err)
          }
        }
      }
    }
  }

  /**
   * Stop the daemon and disconnect sockets.
   */
  public stop(): void {
    if (!this.isRunning) return
    this.isRunning = false
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = undefined
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = undefined
    }

    for (const [userId, userSock] of this.sockets.entries()) {
      this.cleanupSocket(userSock)
    }
    this.sockets.clear()
    console.log('[10X RPC Daemon] Daemon stopped.')
  }

  /**
   * Background tick loop:
   * - Rotates custom status if rotator is enabled
   * - Checks and expires sleep timers
   * - Re-resolves dynamic placeholders ({time}, {uptime}, etc.)
   * - Refreshes near-expiry Discord tokens
   * - Syncs any DB state changes
   */
  public async tick(): Promise<void> {
    this.lastTickAt = new Date()
    const now = new Date()

    // 1. Sync users from DB
    await this.syncAllUsers()

    // 2. Iterate connected users
    for (const [userId, userSock] of this.sockets.entries()) {
      try {
        // Same filtered query as connectUserSocket: latest VALID session that
        // carries a Discord token. Keeps gatewayReady updates on the right row.
        const session = await db.session.findFirst({
          where: { userId, expiresAt: { gt: now }, discordAccessToken: { not: null } },
          orderBy: { createdAt: 'desc' },
          include: {
            user: {
              include: {
                globalConfig: true,
                rotatorPresets: { orderBy: { order: 'asc' } },
                trial: true,
              },
            },
          },
        })

        if (!session) {
          this.disconnectUser(userId)
          continue
        }

        // Check trial
        if (!session.user.trial || !session.user.trial.active || session.user.trial.endsAt < now) {
          console.log(`[10X RPC Daemon] Trial expired for user ${userId}, disabling presence`)
          await db.session.update({
            where: { id: session.id },
            data: { rpcEnabled: false, statusEnabled: false, gatewayReady: false },
          })
          this.disconnectUser(userId)
          continue
        }

        // Check sleep timer
        if (session.sleepTimerActive && session.sleepTimerEndsAt && session.sleepTimerEndsAt <= now) {
          console.log(`[10X RPC Daemon] Sleep timer elapsed for user ${userId}`)
          await db.session.update({
            where: { id: session.id },
            data: {
              sleepTimerActive: false,
              sleepTimerEndsAt: null,
              rpcEnabled: false,
              statusEnabled: false,
              gatewayReady: false,
            },
          })
          // Sleep timer = full RPC stop: disable BOTH modes' enabled flags
          // (each configuration's field data is preserved, only flags flip).
          await Promise.all([
            db.rpcConfig.updateMany({
              where: { userId, enabled: true },
              data: { enabled: false },
            }),
            db.gameConfig.updateMany({
              where: { userId, enabled: true },
              data: { enabled: false },
            }),
          ])
          this.disconnectUser(userId)
          continue
        }

        // Check token expiration (refresh if < 30 mins left)
        if (session.discordTokenExpiresAt && session.discordTokenExpiresAt.getTime() - now.getTime() < 30 * 60 * 1000) {
          if (session.discordRefreshToken) {
            console.log(`[10X RPC Daemon] Refreshing Discord token for user ${userId}...`)
            const refreshed = await refreshDiscordToken(session.discordRefreshToken)
            if (refreshed.ok && refreshed.access_token) {
              await db.session.update({
                where: { id: session.id },
                data: {
                  discordAccessToken: refreshed.access_token,
                  discordRefreshToken: refreshed.refresh_token,
                  discordTokenExpiresAt: new Date(Date.now() + (refreshed.expires_in || 604800) * 1000),
                },
              })
              session.discordAccessToken = refreshed.access_token
            } else if (refreshed.permanent) {
              // Refresh grant definitively dead → clear tokens + drop the
              // user; the site shows the "Reconnect Discord" banner.
              console.warn(`[10X RPC Daemon] Refresh grant dead for user ${userId} — clearing tokens. Re-login required.`)
              await db.session.update({
                where: { id: session.id },
                data: {
                  discordAccessToken: null,
                  discordRefreshToken: null,
                  discordTokenExpiresAt: null,
                  gatewayReady: false,
                },
              }).catch(() => {})
              this.disconnectUser(userId)
              continue
            }
            // Transient refresh failure — keep the current token; the next
            // tick (or the 4004 handler if the gateway rejects it) retries.
          }
        }

        // Check status rotator
        if (session.user.globalConfig?.rotatorEnabled) {
          const presets = session.user.rotatorPresets.filter(p => p.enabled)
          if (presets.length > 0) {
            const totalDurationSecs = presets.reduce((sum, p) => sum + Math.max(1, p.durationMins * 60), 0)
            const referenceTime = presets[0].createdAt.getTime()
            const elapsedSecs = Math.floor((now.getTime() - referenceTime) / 1000)
            const positionInCycle = ((elapsedSecs % totalDurationSecs) + totalDurationSecs) % totalDurationSecs

            let accumulated = 0
            let activeIndex = 0
            for (let i = 0; i < presets.length; i++) {
              const dur = Math.max(1, presets[i].durationMins * 60)
              if (accumulated + dur > positionInCycle) {
                activeIndex = i
                break
              }
              accumulated += dur
            }

            const activePreset = presets[activeIndex]
            if (session.customStatus !== activePreset.text || session.customStatusEmoji !== activePreset.emoji) {
              await db.session.update({
                where: { id: session.id },
                data: {
                  customStatus: activePreset.text,
                  customStatusEmoji: activePreset.emoji,
                },
              })
              session.customStatus = activePreset.text
              session.customStatusEmoji = activePreset.emoji
            }
          }
        }

        // Re-evaluate activities and push OP 3 if needed
        await this.pushPresenceForUser(userId, session)
      } catch (userTickErr) {
        console.error(`[10X RPC Daemon] Error in tick for user ${userId}:`, userTickErr)
      }
    }
  }

  /**
   * Synchronize all active users from Postgres DB.
   * Only keeps connections alive for users with active RPC, custom status, or status rotator.
   * Cleans up and disconnects any user whose RPC and status are disabled.
   */
  public async syncAllUsers(): Promise<void> {
    const now = new Date()
    let activeSessions
    try {
      activeSessions = await db.session.findMany({
        where: {
          expiresAt: { gt: now },
          discordAccessToken: { not: null },
        },
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            include: {
              trial: true,
              globalConfig: true,
              rpcConfigs: true,
              gameConfigs: true,
              rotatorPresets: true,
            },
          },
        },
      })
    } catch (err) {
      // Transient DB outage (e.g. Neon cold start / pooled drop) — keep existing
      // sockets alive and retry on the next tick. NEVER tear anything down here.
      console.error('[10X RPC Daemon] syncAllUsers DB error (will retry next tick):', err)
      return
    }

    const activeUserIds = new Set<string>()

    // Latest session per user. Auth-fatal (4004) decisions must compare against
    // the SAME session the connector uses (latest = createdAt desc) — a user can
    // hold several session rows with different tokens, and comparing against a
    // stale row would unblock the guard every tick and resurrect the 4004 loop.
    const latestTokenByUser = new Map<string, string | null>()
    for (const s of activeSessions) {
      if (!latestTokenByUser.has(s.userId)) latestTokenByUser.set(s.userId, s.discordAccessToken || null)
    }

    for (const session of activeSessions) {
      // Check trial
      if (!session.user.trial || !session.user.trial.active || session.user.trial.endsAt < now) {
        continue
      }
      // Check sleep timer
      if (session.sleepTimerActive && session.sleepTimerEndsAt && session.sleepTimerEndsAt <= now) {
        continue
      }

      const rpcConfig = session.user.rpcConfigs?.[0]
      const enabledGame = session.user.gameConfigs?.find(g => g.enabled) ?? null
      // MUTUAL EXCLUSIVITY: only ONE mode can be active — the daemon uses
      // exclusively the active mode's own config (never a merge of both).
      const selection = selectActiveRpc(session.rpcEnabled, rpcConfig, enabledGame)
      const hasRpc = selection.active
      const hasStatus = !!session.statusEnabled
      const hasRotator = !!(session.statusEnabled && session.user.globalConfig?.rotatorEnabled && session.user.rotatorPresets?.some(p => p.enabled))

      // Only track if user actually has active RPC, active status, or active rotator
      if (!hasRpc && !hasStatus && !hasRotator) {
        continue
      }

      activeUserIds.add(session.userId)
      let userSock = this.sockets.get(session.userId)

      if (!userSock) {
        userSock = {
          userId: session.userId,
          sessionId: session.id,
          ws: null,
          heartbeatAck: true,
          retryCount: 0,
          platform: selection.config?.platform || 'desktop',
          lastStatus: session.userStatus || 'online',
          lastActivitiesHash: '',
          connected: false,
          isConnecting: false,
        }
        this.sockets.set(session.userId, userSock)
      }

      // If socket is disconnected, connect it
      if (!userSock.connected && !userSock.isConnecting) {
        // Auth-fatal guard (4004): skip while the FAILED token is still the
        // user's LATEST token; auto-unblock as soon as a new token lands.
        if (userSock.failedAuthToken) {
          if (userSock.failedAuthToken === (latestTokenByUser.get(session.userId) ?? null)) continue
          userSock.failedAuthToken = null // new token — allow a fresh attempt
        }
        this.connectUserSocket(session.userId)
      }
    }

    // Cleanup and disconnect users that are no longer active (prevents background restarts)
    for (const [userId, userSock] of this.sockets.entries()) {
      if (!activeUserIds.has(userId)) {
        this.disconnectUser(userId)
      }
    }
  }

  /**
   * Stop RPC completely for a user:
   * - Sends OP 3 with empty activities (or custom status only) to clear Discord Rich Presence
   * - Stops all timers and intervals
   * - Disconnects socket if no other presence (e.g. custom status) is needed
   * - Prevents background restarts
   */
  public async stopUserRpc(userId: string): Promise<void> {
    const session = await db.session.findFirst({
      where: { userId, expiresAt: { gt: new Date() }, discordAccessToken: { not: null } },
      orderBy: { createdAt: 'desc' },
    }).catch(() => null)
    if (!session || !session.discordAccessToken) return

    const userSock = this.sockets.get(userId)
    const hasStatus = !!session.statusEnabled
    const hasCustomStatus = !!(session.customStatus || session.customStatusEmoji)

    if (userSock && userSock.ws && userSock.ws.readyState === WebSocket.OPEN) {
      const activities: Array<Record<string, unknown>> = []
      if (hasStatus && hasCustomStatus) {
        const customActivity = buildCustomStatusActivity(
          session.customStatus,
          session.customStatusEmoji
        )
        if (customActivity) activities.push(customActivity)
      }

      const status = hasStatus ? (session.userStatus || 'online') : 'invisible'

      try {
        userSock.ws.send(JSON.stringify({
          op: 3,
          d: {
            status,
            activities,
            afk: false,
            since: null,
          },
        }))
        userSock.lastActivitiesHash = JSON.stringify({ status, activities })
        userSock.lastStatus = status
      } catch (err) {
        console.error(`[10X RPC Daemon] Error sending clear OP 3 for user ${userId}:`, err)
      }

      // If status is not active, close socket cleanly and stop all timers
      if (!hasStatus) {
        this.cleanupSocket(userSock)
        this.sockets.delete(userId)
      }
    } else if (hasStatus) {
      // Connect to Discord Gateway to maintain user status
      await this.connectUserSocket(userId)
    }
  }

  /**
   * Sync a specific user immediately on UI actions (button click, toggle, status change).
   */
  public async syncUser(userId: string): Promise<PresenceResult> {
    const now = new Date()
    const session = await db.session.findFirst({
      where: { userId, expiresAt: { gt: now }, discordAccessToken: { not: null } },
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          include: {
            trial: true,
            globalConfig: true,
            rotatorPresets: true,
          },
        },
      },
    }).catch(() => null)

    if (!session || !session.discordAccessToken) {
      this.disconnectUser(userId)
      return {
        ok: false,
        method: 'none',
        message: 'No active session with Discord token',
      }
    }

    // Trial check
    if (!session.user.trial || !session.user.trial.active || session.user.trial.endsAt < now) {
      this.disconnectUser(userId)
      return {
        ok: false,
        method: 'none',
        message: 'Trial expired',
      }
    }

    const rpcConfig = await db.rpcConfig.findFirst({ where: { userId } })
    const enabledGame = await db.gameConfig.findFirst({ where: { userId, enabled: true } })
    // MUTUAL EXCLUSIVITY: one mode at a time, active config only.
    const selection = selectActiveRpc(session.rpcEnabled, rpcConfig, enabledGame)
    const hasRpc = selection.active
    const hasStatus = !!session.statusEnabled
    const hasRotator = !!(session.statusEnabled && session.user.globalConfig?.rotatorEnabled && session.user.rotatorPresets?.some(p => p.enabled))

    // If neither status, RPC, nor rotator is active: stop & clear
    if (!hasRpc && !hasStatus && !hasRotator) {
      await this.stopUserRpc(userId)
      return {
        ok: true,
        method: 'gateway',
        message: 'Presence disabled & cleared from Discord',
      }
    }

    let userSock = this.sockets.get(userId)
    if (!userSock) {
      userSock = {
        userId,
        sessionId: session.id,
        ws: null,
        heartbeatAck: true,
        retryCount: 0,
        platform: selection.config?.platform || 'desktop',
        lastStatus: session.userStatus || 'online',
        lastActivitiesHash: '',
        connected: false,
        isConnecting: false,
      }
      this.sockets.set(userId, userSock)
    }

    if (!userSock.connected && !userSock.isConnecting) {
      await this.connectUserSocket(userId)
    } else {
      await this.pushPresenceForUser(userId, session, true)
    }

    return {
      ok: true,
      method: 'gateway',
      message: 'Presence synced to 24/7 Gateway',
    }
  }

  /**
   * Connect or reconnect a user's WebSocket to Discord Gaming SDK Gateway.
   */
  private async connectUserSocket(userId: string): Promise<void> {
    const userSock = this.sockets.get(userId)
    if (!userSock || userSock.isConnecting) return

    // Clean up previous socket cleanly before starting new connection
    this.cleanupSocket(userSock)
    userSock.isConnecting = true
    userSock.connectingSince = Date.now()

    try {
      // ══════════════════════════════════════════════════════════════════
      // 24/7 FIX (users with a newer tokenless session never connected):
      // This query MUST match syncAllUsers/syncUser semantics — the LATEST
      // session that is (a) still valid and (b) carries a Discord token.
      // Previously it read the latest session with NO filters, so a newer
      // expired/tokenless row (e.g. an aborted re-login) made this method
      // call disconnectUser() and KILL a working user on every tick.
      // ══════════════════════════════════════════════════════════════════
      const session = await db.session.findFirst({
        where: {
          userId,
          expiresAt: { gt: new Date() },
          discordAccessToken: { not: null },
        },
        orderBy: { createdAt: 'desc' },
      })
      if (!session || !session.discordAccessToken) {
        userSock.isConnecting = false
        this.disconnectUser(userId)
        return
      }

      // Check if token is expired and refresh before connecting
      let accessToken = session.discordAccessToken
      const now = new Date()
      if (session.discordTokenExpiresAt && session.discordTokenExpiresAt < now) {
        if (session.discordRefreshToken) {
          const refreshed = await refreshDiscordToken(session.discordRefreshToken)
          if (refreshed.ok && refreshed.access_token) {
            accessToken = refreshed.access_token
            await db.session.update({
              where: { id: session.id },
              data: {
                discordAccessToken: refreshed.access_token,
                discordRefreshToken: refreshed.refresh_token,
                discordTokenExpiresAt: new Date(Date.now() + (refreshed.expires_in || 604800) * 1000),
              },
            })
          } else if (refreshed.permanent) {
            // Refresh grant definitively dead → clear tokens so the site
            // shows the "Reconnect Discord" banner and syncAllUsers drops
            // the user cleanly instead of 4004-looping forever.
            await db.session.update({
              where: { id: session.id },
              data: {
                discordAccessToken: null,
                discordRefreshToken: null,
                discordTokenExpiresAt: null,
                gatewayReady: false,
              },
            }).catch(() => {})
            userSock.isConnecting = false
            userSock.connectingSince = undefined
            this.disconnectUser(userId)
            return
          } else {
            // TRANSIENT refresh failure (network / Discord 5xx / 429) —
            // the token may still be alive. Back off and retry later;
            // NEVER clear tokens or mark auth-fatal on a transient error.
            console.warn(`[10X RPC Daemon] Transient token refresh failure for user ${userId} — retrying in 60s`)
            userSock.isConnecting = false
            userSock.connectingSince = undefined
            this.scheduleReconnect(userId, 60000)
            return
          }
        }
      }

      // 4004 fatal-auth guard: if this exact token was already rejected by
      // Discord, do NOT open another socket (infinite-loop protection). A NEW
      // token (re-login) clears failedAuthToken in syncAllUsers/syncUser.
      if (userSock.failedAuthToken && userSock.failedAuthToken === accessToken) {
        userSock.isConnecting = false
        userSock.connectingSince = undefined
        return
      }
      userSock.identifiedWith = accessToken
      userSock.failedAuthToken = null // proceeding with this token — clear any stale block

      // Check target platform based on active mode (Normal vs Gamer RPC are
      // exclusive — the socket platform follows the ACTIVE mode's own config).
      const rpcConfig = await db.rpcConfig.findFirst({ where: { userId } })
      const enabledGame = await db.gameConfig.findFirst({ where: { userId, enabled: true } })
      const selection = selectActiveRpc(session.rpcEnabled, rpcConfig, enabledGame)
      const isRpcActive = selection.active
      const isStatusActive = !!session.statusEnabled

      const activePlatform = isStatusActive
        ? (session.statusPlatform || 'mobile')
        : (isRpcActive ? (selection.config?.platform || 'desktop') : (session.statusPlatform || 'mobile'))

      const isQuest = activePlatform === 'meta_quest' || (isStatusActive && session.vrStatusActive)
      const targetPlatform = isQuest ? 'meta_quest' : activePlatform
      userSock.platform = targetPlatform

      const ws = new WebSocket(CONFIG.discord.gatewayUrl)
      userSock.ws = ws

      ws.on('open', () => {
        // Awaiting HELLO (OP 10)
      })

      ws.on('message', async (data: Buffer | string) => {
        try {
          const raw = typeof data === 'string' ? data : data.toString()
          const payload = JSON.parse(raw)
          const op = payload.op
          const t = payload.t

          if (op === 10) {
            // HELLO: Start heartbeats and send IDENTIFY
            const heartbeatInterval = payload.d?.heartbeat_interval || 41250
            userSock.heartbeatAck = true

            userSock.heartbeatTimer = setInterval(() => {
              if (ws.readyState === WebSocket.OPEN) {
                if (!userSock.heartbeatAck) {
                  console.warn(`[10X RPC Daemon] Zombie socket detected for user ${userId} (missing ACK). Reconnecting...`)
                  this.cleanupSocket(userSock)
                  this.scheduleReconnect(userId)
                  return
                }
                userSock.heartbeatAck = false
                userSock.lastHeartbeatSentAt = Date.now()
                ws.send(JSON.stringify({ op: 1, d: null }))
              }
            }, heartbeatInterval)

            const isMobile = targetPlatform === 'android' || targetPlatform === 'ios' || targetPlatform === 'samsung' || targetPlatform === 'mobile'
            const isConsole = targetPlatform === 'console' || targetPlatform === 'xbox' || targetPlatform === 'ps4' || targetPlatform === 'ps5'
            const isWeb = targetPlatform === 'web'

            const properties = isQuest
              ? { os: 'Android', browser: 'Discord VR', device: 'Meta Quest' }
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
              ? { os: 'Windows', browser: 'Discord Web', device: 'Chrome' }
              : { os: 'Windows', browser: 'Discord Client', device: 'Desktop' }

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
          } else if (op === 11) {
            // Heartbeat ACK
            userSock.heartbeatAck = true
            userSock.lastHeartbeatSentAt = undefined
          } else if (op === 1) {
            // Server requested heartbeat
            ws.send(JSON.stringify({ op: 1, d: null }))
          } else if (op === 0 && t === 'READY') {
            // Authenticated and ready! Only trigger initial presence push on READY (NOT on SESSIONS_REPLACE to avoid infinite loop)
            userSock.connected = true
            userSock.isConnecting = false
            userSock.connectingSince = undefined
            userSock.retryCount = 0
            userSock.lastConnectedAt = new Date()

            await db.session.update({
              where: { id: session.id },
              data: {
                gatewayReady: true,
                lastPresenceUpdate: new Date(),
              },
            }).catch(() => {})

            // Push current presence immediately
            await this.pushPresenceForUser(userId, session, true)
          } else if (op === 7) {
            // Discord requested reconnect
            console.log(`[10X RPC Daemon] Discord Gateway sent OP 7 RECONNECT for user ${userId}. Reconnecting...`)
            this.cleanupSocket(userSock)
            this.scheduleReconnect(userId, 1000)
          } else if (op === 9) {
            // Invalid session
            console.warn(`[10X RPC Daemon] Discord Gateway sent OP 9 INVALID_SESSION for user ${userId}`)
            this.cleanupSocket(userSock)
            this.scheduleReconnect(userId, 3000)
          }
        } catch (err) {
          console.error(`[10X RPC Daemon] Error handling WS message for user ${userId}:`, err)
        }
      })

      ws.on('error', (err) => {
        console.error(`[10X RPC Daemon] Gateway WS error for user ${userId}:`, err.message)
        userSock.connected = false
        userSock.isConnecting = false
        this.cleanupSocket(userSock)
        this.scheduleReconnect(userId)
      })

      ws.on('close', async (code, reason) => {
        console.log(`[10X RPC Daemon] Gateway WS closed for user ${userId} (code: ${code}, reason: ${reason.toString() || 'none'})`)
        userSock.connected = false
        userSock.isConnecting = false
        userSock.connectingSince = undefined
        this.cleanupSocket(userSock)

        // CRITICAL 24/7 fix: this handler is async — an unhandled DB error here
        // would crash the whole daemon process. Everything below is guarded.
        try {
          if (code === 4004) {
            // Auth failed — RE-READ the session from the DB (the connect-time
            // snapshot may hold an already-rotated refresh token) and refresh.
            // Same filtered query as connectUserSocket: latest VALID session
            // that carries a token.
            console.log(`[10X RPC Daemon] Auth failed (4004) for user ${userId}. Refreshing token...`)
            const fresh = await db.session.findFirst({
              where: {
                userId,
                expiresAt: { gt: new Date() },
                discordAccessToken: { not: null },
              },
              orderBy: { createdAt: 'desc' },
            }).catch(() => null)

            if (fresh && fresh.discordRefreshToken) {
              const refreshed = await refreshDiscordToken(fresh.discordRefreshToken)
              if (refreshed.ok && refreshed.access_token) {
                await db.session.update({
                  where: { id: fresh.id },
                  data: {
                    discordAccessToken: refreshed.access_token,
                    discordRefreshToken: refreshed.refresh_token,
                    discordTokenExpiresAt: new Date(Date.now() + (refreshed.expires_in || 604800) * 1000),
                  },
                })
                userSock.failedAuthToken = null // fresh token — retry allowed
                this.scheduleReconnect(userId, 2000)
                return
              }
              if (refreshed.permanent) {
                // Refresh grant definitively dead → clear tokens so the site
                // prompts re-login and syncAllUsers drops the user cleanly.
                console.warn(`[10X RPC Daemon] Refresh grant dead for user ${userId} — clearing tokens. Re-login required.`)
                await db.session.update({
                  where: { id: fresh.id },
                  data: {
                    discordAccessToken: null,
                    discordRefreshToken: null,
                    discordTokenExpiresAt: null,
                    gatewayReady: false,
                  },
                }).catch(() => {})
                userSock.failedAuthToken = userSock.identifiedWith || null
                userSock.retryCount = 0
                return
              }
              // TRANSIENT refresh failure — tokens may still be valid after
              // Discord recovers. Back off (self-heal), never mark auth-fatal.
              console.warn(`[10X RPC Daemon] Transient refresh failure for user ${userId} after 4004 — retrying in 60s`)
              this.scheduleReconnect(userId, 60000)
              return
            }

            if (fresh && !fresh.discordRefreshToken) {
              // Token with NO refresh path (legacy raw user token) is dead —
              // clearing it lets the UI prompt re-login and stops the loop.
              console.warn(`[10X RPC Daemon] Dead token without refresh token for user ${userId} — clearing. Re-login required.`)
              await db.session.update({
                where: { id: fresh.id },
                data: {
                  discordAccessToken: null,
                  discordRefreshToken: null,
                  discordTokenExpiresAt: null,
                  gatewayReady: false,
                },
              }).catch(() => {})
            }
            // No valid token session left → nothing to authenticate with.
            userSock.failedAuthToken = userSock.identifiedWith || null
            userSock.retryCount = 0
            return
          } else if (code === 4008) {
            // Rate limited — back off for 60 seconds to allow rate limit window to clear
            console.warn(`[10X RPC Daemon] Rate limited by Discord Gateway for user ${userId}. Backing off for 60s...`)
            this.scheduleReconnect(userId, 60000)
            return
          }

          this.scheduleReconnect(userId)
        } catch (closeErr) {
          console.error(`[10X RPC Daemon] Error in close handler for user ${userId} (daemon stays alive):`, closeErr)
          this.scheduleReconnect(userId)
        }
      })
    } catch (err) {
      console.error(`[10X RPC Daemon] Failed to initialize connection for user ${userId}:`, err)
      userSock.connected = false
      userSock.isConnecting = false
      this.scheduleReconnect(userId)
    }
  }

  /**
   * Schedule reconnection with exponential backoff.
   */
  private scheduleReconnect(userId: string, customDelayMs?: number): void {
    const userSock = this.sockets.get(userId)
    if (!userSock || userSock.retryTimer) return

    const delay = customDelayMs ?? Math.min(30000, 1000 * Math.pow(1.5, Math.min(userSock.retryCount, 8)))
    userSock.retryCount++

    userSock.retryTimer = setTimeout(() => {
      userSock.retryTimer = undefined
      this.connectUserSocket(userId)
    }, delay)
  }

  /**
   * Build activities and send OP 3 for the user if anything changed or on reconnect.
   */
  private async pushPresenceForUser(userId: string, session: any, force: boolean = false): Promise<void> {
    const userSock = this.sockets.get(userId)
    if (!userSock || !userSock.ws || userSock.ws.readyState !== WebSocket.OPEN) return

    type RpcCfgRow = Awaited<ReturnType<typeof db.rpcConfig.findFirst>>
    type GlobalCfgRow = Awaited<ReturnType<typeof db.globalConfig.findUnique>>
    type GameCfgRow = Awaited<ReturnType<typeof db.gameConfig.findFirst>>
    let rpcConfig: RpcCfgRow = null
    let globalConfig: GlobalCfgRow = null
    let enabledGame: GameCfgRow = null
    try {
      const [rpc, glob, game] = await Promise.all([
        db.rpcConfig.findFirst({ where: { userId } }),
        db.globalConfig.findUnique({ where: { userId } }),
        db.gameConfig.findFirst({ where: { userId, enabled: true } }),
      ])
      rpcConfig = rpc
      globalConfig = glob
      enabledGame = game
    } catch (dbErr) {
      console.warn(`[10X RPC Daemon] Transient DB error in pushPresenceForUser for user ${userId}:`, dbErr)
      return
    }

    const placeholderCtx: PlaceholderContext = {
      timezone: globalConfig?.timezone || 'UTC',
      city: globalConfig?.city || undefined,
      rpcStartedAt: (rpcConfig?.updatedAt || enabledGame?.updatedAt)
        ? new Date((rpcConfig?.updatedAt || enabledGame?.updatedAt) as Date).getTime()
        : (session.lastPresenceUpdate ? new Date(session.lastPresenceUpdate).getTime() : Date.now()),
    }

    // MUTUAL EXCLUSIVITY — Normal RPC (RpcConfig) and Gamer RPC (GameConfig)
    // are completely separate configurations. Pick the ONE active mode and use
    // ONLY that mode's own config; never merge or cross-read the other's data.
    const selection = selectActiveRpc(session.rpcEnabled, rpcConfig, enabledGame)
    const isRpcActive = selection.active
    const isStatusActive = !!session.statusEnabled

    const activePlatform = isStatusActive
      ? (session.statusPlatform || 'mobile')
      : (isRpcActive ? (selection.config?.platform || 'desktop') : (session.statusPlatform || 'mobile'))
    userSock.platform = activePlatform === 'meta_quest' ? 'meta_quest' : activePlatform

    // Custom games may carry a Discord Application ID — spoof that application.
    const selectedGameAppId = isRpcActive && selection.mode === 'game'
      ? await fetchGameAppId(userId, selection.gameSlug)
      : null

    const activities = await buildPresenceActivities({
      rpcConfig: isRpcActive ? selection.config : null,
      customStatus: isStatusActive ? session.customStatus : null,
      customStatusEmoji: isStatusActive ? session.customStatusEmoji : null,
      placeholderCtx,
      vrStatusActive: (isStatusActive && session.statusPlatform === 'meta_quest') || (isRpcActive && selection.config?.platform === 'meta_quest'),
      platform: isRpcActive ? (selection.config?.platform || 'desktop') : (session.statusPlatform || 'mobile'),
      // User OAuth token — required to resolve image URLs into animated-capable
      // mp:external asset references via Discord's external-assets endpoint.
      userAccessToken: session.discordAccessToken,
      // Only the GAME mode's own enabled game drives official-app spoofing
      // (real app_id/name/icon). Normal mode never spoofs.
      selectedGameSlug: isRpcActive && selection.mode === 'game' ? selection.gameSlug : null,
      selectedGameAppId,
    })

    // Defense-in-depth: raw http(s) URLs inside assets are silently dropped by
    // Discord. Strip them so a failed asset resolution can never make the RPC
    // image disappear (the "image not showing" bug).
    const safeActivities = sanitizeActivities(activities as Array<Record<string, unknown>>)

    const status = isStatusActive ? (session.userStatus || 'online') : (isRpcActive ? 'online' : 'invisible')
    const activitiesHash = JSON.stringify({ status, activities: safeActivities })

    // Avoid spamming identical OP 3 payloads unless forced (prevents rate limits)
    if (!force && userSock.lastActivitiesHash === activitiesHash && userSock.lastStatus === status) {
      return
    }

    // If socket is open and payload is ready, send OP 3
    if (!userSock.ws || userSock.ws.readyState !== WebSocket.OPEN) return

    // Zombie push guard — SLOW-UPDATE FIX: if our last heartbeat went
    // unanswered for >15s the TCP connection is half-dead; an OP 3 sent now
    // would vanish silently while marking the payload as "delivered" (hash
    // updated), freezing the profile until the 10-min watchdog. Detect and
    // reconnect instead, leaving the hash untouched so the reconnect's forced
    // push re-sends the current presence immediately.
    const heartbeatPendingMs = userSock.lastHeartbeatSentAt
      ? Date.now() - userSock.lastHeartbeatSentAt
      : 0
    if (!userSock.heartbeatAck && heartbeatPendingMs > 15000) {
      console.warn(`[10X RPC Daemon] Zombie push guard: user ${userId} heartbeat unanswered for ${Math.round(heartbeatPendingMs / 1000)}s. Reconnecting instead of pushing into the void...`)
      this.cleanupSocket(userSock)
      this.scheduleReconnect(userId)
      return
    }

    try {
      console.log(`[10X RPC Daemon] Sending OP 3 for user ${userId}: status=${status}, activities=${JSON.stringify(safeActivities)}`)
      userSock.ws.send(JSON.stringify({
        op: 3,
        d: {
          status,
          activities: safeActivities,
          afk: false,
          since: null,
        },
      }))
      userSock.lastStatus = status
      userSock.lastActivitiesHash = activitiesHash
      userSock.lastPushAt = Date.now()
    } catch (err) {
      console.error(`[10X RPC Daemon] Failed to send OP 3 for user ${userId}:`, err)
    }
  }

  /**
   * Disconnect and remove a user from the daemon.
   */
  public disconnectUser(userId: string): void {
    const userSock = this.sockets.get(userId)
    if (!userSock) return

    this.cleanupSocket(userSock)
    this.sockets.delete(userId)
    console.log(`[10X RPC Daemon] Disconnected user ${userId}`)
  }

  /**
   * Clean up a socket and its timers.
   */
  private cleanupSocket(userSock: ActiveUserSocket): void {
    if (userSock.heartbeatTimer) {
      clearInterval(userSock.heartbeatTimer)
      userSock.heartbeatTimer = undefined
    }
    if (userSock.retryTimer) {
      clearTimeout(userSock.retryTimer)
      userSock.retryTimer = undefined
    }
    userSock.connectingSince = undefined
    userSock.lastHeartbeatSentAt = undefined
    if (userSock.ws) {
      try {
        userSock.ws.removeAllListeners()
        userSock.ws.close()
      } catch {}
      userSock.ws = null
    }
    userSock.connected = false
    userSock.isConnecting = false
  }

  /**
   * Get daemon metrics and status for health endpoint.
   */
  public getStatus() {
    return {
      running: this.isRunning,
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      lastTickAt: this.lastTickAt,
      activeConnections: Array.from(this.sockets.values()).filter(s => s.connected).length,
      totalTrackedUsers: this.sockets.size,
      authFailedUsers: Array.from(this.sockets.values()).filter(s => s.failedAuthToken).length,
      users: Array.from(this.sockets.values()).map(s => ({
        userId: s.userId,
        connected: s.connected,
        platform: s.platform,
        lastStatus: s.lastStatus,
        lastConnectedAt: s.lastConnectedAt,
        lastPushAt: s.lastPushAt ? new Date(s.lastPushAt).toISOString() : null,
      })),
    }
  }
}

// Global singleton for Next.js and server environments
declare global {
  var __rpcDaemonInstance: RpcDaemon | undefined
}

export function getRpcDaemon(): RpcDaemon {
  if (!global.__rpcDaemonInstance) {
    global.__rpcDaemonInstance = new RpcDaemon()
  }
  return global.__rpcDaemonInstance
}

/**
 * Helper to ensure the 24/7 daemon is started.
 */
export function ensureDaemonRunning(): RpcDaemon {
  const daemon = getRpcDaemon()
  daemon.start().catch(err => {
    console.error('[10X RPC Daemon] Failed to start daemon:', err)
  })
  return daemon
}
