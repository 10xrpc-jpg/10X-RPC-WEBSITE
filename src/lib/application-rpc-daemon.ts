// 10X RPC — Application RPC Daemon (Task 90 — the THIRD, fully independent RPC system)
//
// Own execution path for the Application RPC. This daemon deliberately shares
// NOTHING with the Normal RPC / Game RPC daemon (rpc-daemon.ts):
//   • own tick loop + watchdog (started alongside the main daemon by the
//     standalone runner; the in-process dev fallback starts its own instance)
//   • own gateway WebSocket sessions (one per user, platform chosen by the
//     Application RPC's own config — default meta_quest/VR). Task 91: the
//     session platform doubles as the ACTIVITY-level `platform` label — the
//     field Discord clients merge profile cards by. When the saved platform
//     is already used by an enabled Normal RPC slot (live example: slot 1 =
//     meta_quest), this daemon deterministically moves itself to a free
//     label (samsung → ps5 → embedded → …) so the two cards can never merge
//     into one — that collision was exactly the "only one RPC shows" bug.
//   • own Database access: every ApplicationRpcConfig read/write goes through
//     $queryRaw so this works on ANY Prisma client generation (the standalone
//     Orihost daemon's client may predate the ApplicationRpcConfig model — raw
//     SQL only needs the TABLE to exist, exactly like the Subscription gate)
//   • own status tracking: runState / runError / runSinceAt written with raw
//     SQL that NEVER touches updatedAt (the activity's elapsed-time anchor)
//
// Isolation guarantees (Task 90 spec):
//   • reads ONLY ApplicationRpcConfig + Session + Subscription (read-only)
//   • never writes RpcConfig, GameConfig, GlobalConfig or Session — the Normal
//     and Game systems are untouched by every code path below
//   • never refreshes or clears Discord OAuth tokens (refresh is the Normal
//     daemon's + website's job) — this daemon re-reads the session each tick
//     and picks up any new token automatically; if Discord rejects the stored
//     token it reports an honest error state instead of touching the tokens
//   • the sleep timer is honored INDEPENDENTLY: expiry stops ONLY the
//     Application RPC (its own enabled flag) — never the other systems

import WebSocket from 'ws'
import { CONFIG } from './config'
import { db } from './db'
import { buildActivityPayload, assignDisplayTypes, type DisplayTypeCandidate } from './rpc-manager'
import { resolvePlaceholders, type PlaceholderContext } from './placeholders'
import { sanitizeActivities } from './discord-assets'
import { discordAuthValue } from './discord-auth'
import { buildIdentify } from './gateway-platform'
import { isUsableApplicationRpcAppId, normalizeRunState } from './application-rpc'

/** Raw-SQL row shape for the Application RPC config (provider-portable). */
interface AppRpcRow {
  id: string
  userId: string
  name: string
  type: string
  platform: string
  appId: string | null
  state: string | null
  details: string | null
  largeImage: string | null
  largeText: string | null
  smallImage: string | null
  smallText: string | null
  button1Label: string | null
  button1Url: string | null
  button2Label: string | null
  button2Url: string | null
  partyCurrent: number | null
  partyMax: number | null
  startMinsAgo: number
  endTotalMins: number | null
  enabled: boolean
  runState: string
  runError: string | null
  runSinceAt: string | null
  updatedAt: Date | string | null
}

/** Read-only subscription view (same policy as the main daemon, no writes). */
interface AppSubRow {
  plan: string
  status: string
  trialEndsAt: Date | string | null
  currentPeriodEnd: Date | string | null
}

/** One Application RPC gateway session per user. */
interface AppRpcSocket {
  userId: string
  ws: WebSocket | null
  heartbeatTimer?: NodeJS.Timeout
  heartbeatAck: boolean
  lastHeartbeatSentAt?: number
  retryCount: number
  retryTimer?: NodeJS.Timeout
  connected: boolean
  isConnecting: boolean
  connectingSince?: number
  identifiedPlatform?: string
  /** Task 91 — the ACTIVITY-level platform label this session pushes (the
   *  card-merge key). Equal to the session's identify platform so Discord
   *  accepts the activity (mismatched labels get the whole activity
   *  rejected). Recomputed every tick from the user's enabled Normal slots;
   *  a change triggers one reconnect with the matched identify. */
  activityLabel?: string
  /** The Discord token whose IDENTIFY was rejected with 4004. Retrying the
   *  same dead token hits 4004 forever — stay down until the stored token
   *  CHANGES (re-login, or the Normal daemon's refresh landing in the DB). */
  failedAuthToken?: string | null
  lastFailAt?: number
  lastEchoSig?: string
  lastPushAt?: number
}

const CONNECT_TIMEOUT_MS = 15000
const REOPEN_BACKOFF_MS = 45000
const TICK_MS = 10000

export class ApplicationRpcDaemon {
  private sockets = new Map<string, AppRpcSocket>()
  private tickTimer?: NodeJS.Timeout
  private watchdogTimer?: NodeJS.Timeout
  private isRunning = false
  private startTime = Date.now()
  private lastTickAt: Date | null = null

  /** Start the independent 24/7 loop. */
  public async start(): Promise<void> {
    if (this.isRunning) return
    this.isRunning = true
    this.startTime = Date.now()
    console.log('[10X RPC AppDaemon] Starting Application RPC daemon...')

    await this.tick().catch(err => {
      console.error('[10X RPC AppDaemon] Initial tick error:', err)
    })

    this.tickTimer = setInterval(() => {
      this.tick().catch(err => {
        console.error('[10X RPC AppDaemon] Tick error:', err)
      })
    }, TICK_MS)

    this.watchdogTimer = setInterval(() => {
      this.watchdog().catch(err => {
        console.error('[10X RPC AppDaemon] Watchdog error:', err)
      })
    }, 60000)

    console.log('[10X RPC AppDaemon] Application RPC daemon started.')
  }

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
    for (const sock of this.sockets.values()) this.cleanupSocket(sock)
    this.sockets.clear()
    console.log('[10X RPC AppDaemon] Application RPC daemon stopped.')
  }

  // ─── Database helpers (raw SQL — provider-portable, Orihost-safe) ─────────
  // NOTE: the column list is INLINED in every query template — $queryRaw
  // treats interpolated JS strings as bound parameters, NOT SQL fragments.

  private async loadRow(userId: string): Promise<AppRpcRow | null> {
    try {
      const rows = await db.$queryRaw<AppRpcRow[]>`
        SELECT "id", "userId", "name", "type", "platform", "appId",
               "state", "details", "largeImage", "largeText", "smallImage", "smallText",
               "button1Label", "button1Url", "button2Label", "button2Url",
               "partyCurrent", "partyMax", "startMinsAgo", "endTotalMins",
               "enabled", "runState", "runError", "runSinceAt", "updatedAt"
        FROM "ApplicationRpcConfig" WHERE "userId" = ${userId} LIMIT 1`
      return rows?.[0] ?? null
    } catch {
      // Table not migrated yet (or transient DB outage) → treat as disabled.
      return null
    }
  }

  private async loadEnabledRows(): Promise<AppRpcRow[]> {
    try {
      return await db.$queryRaw<AppRpcRow[]>`
        SELECT "id", "userId", "name", "type", "platform", "appId",
               "state", "details", "largeImage", "largeText", "smallImage", "smallText",
               "button1Label", "button1Url", "button2Label", "button2Url",
               "partyCurrent", "partyMax", "startMinsAgo", "endTotalMins",
               "enabled", "runState", "runError", "runSinceAt", "updatedAt"
        FROM "ApplicationRpcConfig" WHERE "enabled" = ${true}`
    } catch {
      // Table missing (pre-migration daemon) → nobody uses Application RPC yet.
      return []
    }
  }

  /**
   * Write the run state — the daemon's OWN status surface. Raw SQL so it
   * never touches updatedAt (the elapsed-time anchor) and works on any
   * Prisma client. Only called on real transitions.
   */
  private async writeRunState(userId: string, state: string, error: string | null): Promise<void> {
    try {
      await db.$executeRaw`
        UPDATE "ApplicationRpcConfig"
        SET "runState" = ${state}, "runError" = ${error}, "runSinceAt" = ${new Date().toISOString()}
        WHERE "userId" = ${userId}`
    } catch (err) {
      console.warn(`[10X RPC AppDaemon] runState write failed for user ${userId}:`, err instanceof Error ? err.message : err)
    }
  }

  /** Transition helper — writes ONLY when the stored state actually differs. */
  private async transitionRunState(
    row: Pick<AppRpcRow, 'userId' | 'runState' | 'runError'>,
    state: string,
    error: string | null,
  ): Promise<void> {
    if (row.runState === state && (row.runError ?? null) === (error ?? null)) return
    await this.writeRunState(row.userId, state, error)
    row.runState = state
    row.runError = error
  }

  // ─── Tick / watchdog ───────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    this.lastTickAt = new Date()

    const rows = await this.loadEnabledRows()
    const enabledIds = new Set(rows.map(r => r.userId))

    // Users whose Application RPC is no longer enabled → close their session
    // and settle the row back to idle (this system's own state only).
    for (const [userId, sock] of this.sockets.entries()) {
      if (!enabledIds.has(userId)) {
        this.cleanupSocket(sock)
        this.sockets.delete(userId)
        const row = await this.loadRow(userId)
        if (row) await this.transitionRunState(row, 'idle', null)
      }
    }

    for (const row of rows) {
      try {
        await this.maintainUser(row, false)
      } catch (err) {
        console.error(`[10X RPC AppDaemon] Maintain error for user ${row.userId}:`, err)
      }
    }
  }

  /** 24/7 self-healing — mirror of the main daemon's watchdog, own sockets. */
  private async watchdog(): Promise<void> {
    const nowMs = Date.now()

    if (this.isRunning && this.lastTickAt && nowMs - this.lastTickAt.getTime() > 90000) {
      console.warn('[10X RPC AppDaemon] Watchdog: tick loop stalled (>90s). Forcing recovery tick...')
      this.lastTickAt = new Date()
      await this.tick().catch(() => {})
    }

    for (const [userId, sock] of this.sockets.entries()) {
      if (sock.isConnecting && sock.connectingSince && nowMs - sock.connectingSince > 60000) {
        console.warn(`[10X RPC AppDaemon] Watchdog: connection for user ${userId} stuck in connecting. Resetting...`)
        this.cleanupSocket(sock)
        this.scheduleReconnect(userId, 1000)
        continue
      }
      if (!sock.connected && !sock.isConnecting && !sock.retryTimer) {
        if (sock.failedAuthToken) continue // stays down until the stored token changes
        this.scheduleReconnect(userId, 1000)
        continue
      }
    }
  }

  // ─── Per-user maintenance (the whole independent lifecycle) ───────────────

  /**
   * Task 91 — resolve THIS user's activity-level platform label (the card
   * merge key). The saved Application RPC platform wins UNLESS an ENABLED
   * Normal RPC slot already uses it (their two cards would merge into one —
   * live-verified root cause of "only one RPC shows"). Deterministic and
   * race-free: derived purely from saved configs, re-evaluated every tick.
   * Read-only: one raw SELECT against RpcConfig, zero writes to it.
   */
  private async resolveActivityLabel(userId: string, row: AppRpcRow): Promise<string> {
    const desired = row.platform || 'meta_quest'
    let used: string[] = []
    try {
      const rows = await db.$queryRaw<Array<{ platform: string | null }>>`
        SELECT "platform" FROM "RpcConfig" WHERE "userId" = ${userId} AND "enabled" = ${true}`
      used = (rows ?? []).map(r => r.platform).filter((p): p is string => !!p)
    } catch { /* table missing / transient DB issue — no Normal slots known */ }
    if (!used.includes(desired)) return desired
    // Task 91 pool — labels the Normal/Game extras NEVER take (their pool is
    // ps4/xbox/android/ios), so these three are collision-free by construction.
    const fallback = ['samsung', 'ps5', 'embedded', 'ps4', 'xbox', 'android', 'ios']
    const free = fallback.find(p => !used.includes(p))
    // (no per-tick log here — the tick runs every 10s; maintainUser logs the
    // actual label CHANGE on the socket, which is the actionable event)
    return free ?? 'desktop'
  }

  private async maintainUser(row: AppRpcRow, forceConnect: boolean): Promise<void> {
    const userId = row.userId
    const now = new Date()

    // Latest valid session that carries a Discord token (same filtered query
    // semantics as the main daemon — read-only).
    const session = await db.session.findFirst({
      where: { userId, expiresAt: { gt: now }, discordAccessToken: { not: null } },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { discordId: true } } },
    }).catch(() => null)

    if (!session || !session.discordAccessToken) {
      this.ensureSocketClosed(userId)
      await this.transitionRunState(row, 'error', 'Discord account not linked (or link expired) — reconnect Discord on the dashboard.')
      return
    }

    // Sleep timer — honored INDEPENDENTLY: expiry stops ONLY the Application
    // RPC (its own enabled flag + idle state). The Normal/Game systems run
    // their own independent sleep-timer handling; neither touches the other.
    if (session.sleepTimerActive && session.sleepTimerEndsAt && session.sleepTimerEndsAt <= now) {
      console.log(`[10X RPC AppDaemon] Sleep timer elapsed for user ${userId} — stopping Application RPC (this system only)`)
      await this.stopAndDisable(userId, 'Sleep timer ended — Application RPC stopped.')
      return
    }

    // Subscription gate — same rules, read-only (the Normal daemon + website
    // sweep own the suspension transitions; this daemon just refuses to run).
    const sub = await this.subscriptionAllows(userId, session.user.discordId)
    if (!sub.ok) {
      this.ensureSocketClosed(userId)
      await this.transitionRunState(row, 'error', sub.message)
      return
    }

    // Defensive re-validation of the Application ID (the route validates on
    // save/enable; this keeps a legacy hand-edited row honest).
    if (!isUsableApplicationRpcAppId(row.appId)) {
      this.ensureSocketClosed(userId)
      await this.transitionRunState(row, 'error', 'No valid Application ID set — open the Application RPC card, enter an Application ID and save.')
      return
    }

    // Task 91 — resolve the card-merge label BEFORE any socket decision so a
    // label change both drives the identify AND the pushed activity.
    const activityLabel = await this.resolveActivityLabel(userId, row)
    const sock = this.ensureSocket(userId)
    if (sock.activityLabel !== activityLabel) {
      const hadSocket = sock.connected || sock.isConnecting
      sock.activityLabel = activityLabel
      if (hadSocket) {
        // Label changed (user enabled/changed a Normal slot platform) — the
        // session must re-identify with the MATCHED platform so Discord
        // accepts the relabeled activity.
        console.log(`[10X RPC AppDaemon] Activity label changed for user ${userId} → "${activityLabel}" — reconnecting with matched identify`)
        this.cleanupSocket(sock)
      }
    }

    // A NEW token landed (re-login or the Normal daemon refreshed it) — clear
    // the auth-fatal block and retry with the fresh token automatically.
    if (sock.failedAuthToken && sock.failedAuthToken !== session.discordAccessToken) {
      sock.failedAuthToken = null
      sock.retryCount = 0
    }
    // An EXPLICIT user action (syncUser from a save/toggle) always gets one
    // fresh attempt — re-enabling with the same token re-runs the connect so
    // the honest error state re-surfaces within seconds instead of leaving
    // the card stuck on "Starting…".
    if (forceConnect && sock.failedAuthToken) {
      sock.failedAuthToken = null
      sock.retryCount = 0
    }

    if (!sock.connected && !sock.isConnecting) {
      if (forceConnect && sock.retryTimer) {
        clearTimeout(sock.retryTimer)
        sock.retryTimer = undefined
      }
      const backoffOk = !sock.lastFailAt || (Date.now() - sock.lastFailAt >= REOPEN_BACKOFF_MS)
      if (forceConnect || backoffOk) {
        await this.connectUserSocket(userId, row, session.discordAccessToken, activityLabel)
      }
      return
    }

    // Connected → re-assert the CURRENT payload every tick (same proven
    // bucket re-assert the Multi-Session extras use: idempotent, cheap, and
    // self-heals any same-class overwrite from another integration within 10s).
    if (sock.connected && sock.ws && sock.ws.readyState === WebSocket.OPEN) {
      const activity = await this.buildActivity(row, session.discordAccessToken, activityLabel)
      if (!activity) {
        await this.transitionRunState(row, 'error', 'Failed to build the presence payload — check the saved Application RPC fields.')
        return
      }
      const status = session.statusEnabled ? (session.userStatus || 'online') : 'online'
      try {
        sock.ws.send(JSON.stringify({
          op: 3,
          d: { status, activities: [activity], afk: false, since: null },
        }))
        sock.lastPushAt = Date.now()
        await this.transitionRunState(row, 'running', null)
      } catch (err) {
        console.error(`[10X RPC AppDaemon] OP 3 send failed for user ${userId}:`, err)
      }
    }
  }

  // ─── Gateway session (own implementation, proven patterns) ────────────────

  private async connectUserSocket(userId: string, row: AppRpcRow, accessToken: string, activityLabel?: string): Promise<void> {
    const sock = this.ensureSocket(userId)
    if (sock.isConnecting) return
    if (!accessToken) return // nothing to identify with — maintenance re-checks the session

    // 4004 fatal-auth guard: never re-identify with a token Discord rejected.
    if (sock.failedAuthToken && sock.failedAuthToken === accessToken) return

    this.cleanupSocket(sock)
    sock.isConnecting = true
    sock.connectingSince = Date.now()

    // Task 91 — the session identify platform = the activity label (matched
    // pair). Discord rejects activities whose platform label does not fit the
    // session, and the label is the client-side card-merge key — the pair
    // must agree. Falls back to the row's saved platform.
    const platform = (activityLabel ?? sock.activityLabel ?? row.platform) || 'meta_quest'
    sock.identifiedPlatform = platform
    sock.activityLabel = platform

    let settled = false
    const markSettled = () => {
      if (!settled) {
        settled = true
      }
    }

    try {
      const ws = new WebSocket(CONFIG.discord.gatewayUrl)
      sock.ws = ws

      const connectTimeout = setTimeout(() => {
        if (!settled) {
          settled = true
          sock.isConnecting = false
          sock.lastFailAt = Date.now()
          console.warn(`[10X RPC AppDaemon] Connect timeout for user ${userId} (${platform})`)
          try { ws.terminate() } catch {}
        }
      }, CONNECT_TIMEOUT_MS)

      ws.on('message', (data: Buffer | string) => {
        try {
          const payload = JSON.parse(typeof data === 'string' ? data : data.toString())
          const op = payload.op
          const t = payload.t

          if (op === 10) {
            const interval = payload.d?.heartbeat_interval || 41250
            sock.heartbeatAck = true
            sock.heartbeatTimer = setInterval(() => {
              if (!sock.ws || sock.ws.readyState !== WebSocket.OPEN) {
                if (sock.heartbeatTimer) clearInterval(sock.heartbeatTimer)
                return
              }
              if (!sock.heartbeatAck && sock.lastHeartbeatSentAt && Date.now() - sock.lastHeartbeatSentAt > 20000) {
                // Zombie socket — drop it; maintenance reconnects.
                if (sock.heartbeatTimer) clearInterval(sock.heartbeatTimer)
                this.closeSocket(sock)
                return
              }
              sock.heartbeatAck = false
              sock.lastHeartbeatSentAt = Date.now()
              try { sock.ws.send(JSON.stringify({ op: 1, d: null })) } catch {}
            }, interval)

            // Full official-client properties per platform (same identify
            // builder the rest of the platform uses — capabilities must NEVER
            // be sent; see gateway-platform.ts).
            const { properties } = buildIdentify(platform)
            ws.send(JSON.stringify({
              op: 2,
              d: { token: discordAuthValue(accessToken), properties },
            }))
          } else if (op === 11) {
            sock.heartbeatAck = true
            sock.lastHeartbeatSentAt = undefined
          } else if (op === 1) {
            try { ws.send(JSON.stringify({ op: 1, d: null })) } catch {}
          } else if (op === 0 && t === 'READY') {
            markSettled()
            clearTimeout(connectTimeout)
            sock.connected = true
            sock.isConnecting = false
            sock.connectingSince = undefined
            sock.retryCount = 0
            console.log(`[10X RPC AppDaemon] Application RPC session live for user ${userId} (platform=${platform}, app=${row.appId ?? '?'})`)
            // The tick's re-assert pushes the payload; force an immediate one
            // so the card appears the moment the session is ready.
            this.maintainUser(row, false).catch(() => {})
          } else if (op === 0 && t === 'PRESENCE_UPDATE') {
            // Own-echo only — the authoritative "what Discord accepted".
            const echoUserId = (payload.d as { user?: { id?: string } } | undefined)?.user?.id
            if (echoUserId === userId) {
              try {
                const acts = (payload.d as { activities?: Array<{ name?: string; type?: number }> } | undefined)?.activities
                if (Array.isArray(acts)) {
                  const sig = acts.map(a => `${a.name ?? '?'}:${a.type ?? '?'}`).join('|')
                  if (sig !== sock.lastEchoSig) {
                    sock.lastEchoSig = sig
                    console.log(`[10X RPC AppDaemon] Discord accepted for user ${userId} (Application RPC): [${sig}]`)
                  }
                }
              } catch {}
            }
          } else if (op === 9) {
            markSettled()
            clearTimeout(connectTimeout)
            sock.isConnecting = false
            sock.lastFailAt = Date.now()
            this.closeSocket(sock)
            console.warn(`[10X RPC AppDaemon] OP 9 for user ${userId} (Application RPC) — backing off`)
          }
        } catch { /* ignore parse errors */ }
      })

      ws.on('error', () => {
        markSettled()
        clearTimeout(connectTimeout)
        sock.isConnecting = false
        sock.lastFailAt = Date.now()
        this.closeSocket(sock)
      })

      ws.on('close', (code, reason) => {
        markSettled()
        clearTimeout(connectTimeout)
        const wasConnected = sock.connected
        sock.connected = false
        sock.isConnecting = false
        sock.connectingSince = undefined
        if (sock.heartbeatTimer) {
          clearInterval(sock.heartbeatTimer)
          sock.heartbeatTimer = undefined
        }
        if (wasConnected || code !== 1000) {
          console.warn(`[10X RPC AppDaemon] Session closed for user ${userId} (Application RPC) — code=${code} reason=${reason?.toString?.() || 'none'}`)
        }
        sock.lastFailAt = Date.now()

        // Honest status + targeted messages. NOTE: tokens are NEVER refreshed
        // or cleared here — this daemon only reports; the Normal daemon and
        // the website own token lifecycle, and a fresh DB token auto-retries.
        void (async () => {
          try {
            const freshRow = await this.loadRow(userId)
            if (!freshRow || !freshRow.enabled) return // disabled meanwhile — idle state already settled
            if (code === 4004) {
              sock.failedAuthToken = accessToken
              await this.transitionRunState(freshRow, 'error', 'Discord rejected the saved connection (auth failed) — click Reconnect Discord; Application RPC resumes automatically afterwards.')
            } else if (code === 4008) {
              await this.transitionRunState(freshRow, 'error', 'Discord temporarily rate-limited this RPC — retrying automatically in about a minute.')
            } else if (sock.failedAuthToken) {
              await this.transitionRunState(freshRow, 'error', 'Discord rejected the saved connection (auth failed) — click Reconnect Discord; Application RPC resumes automatically afterwards.')
            } else {
              await this.transitionRunState(freshRow, 'error', 'Connection lost — the daemon is retrying automatically.')
            }
          } catch { /* best-effort status */ }
        })()
      })
    } catch (err) {
      console.error(`[10X RPC AppDaemon] Failed to open Application RPC session for user ${userId}:`, err)
      sock.isConnecting = false
      sock.lastFailAt = Date.now()
      this.scheduleReconnect(userId)
    }
  }

  private scheduleReconnect(userId: string, customDelayMs?: number): void {
    const sock = this.sockets.get(userId)
    if (!sock || sock.retryTimer) return
    const delay = customDelayMs ?? Math.min(30000, Math.max(3000, 1000 * Math.pow(1.5, Math.min(sock.retryCount, 8))))
    sock.retryCount++
    sock.retryTimer = setTimeout(() => {
      sock.retryTimer = undefined
      // Re-evaluate the row at connect time — the user may have disabled or
      // re-saved while the backoff was pending.
      void (async () => {
        const row = await this.loadRow(userId)
        if (!row || !row.enabled) return
        const token = await this.currentToken(userId)
        if (!token) return
        await this.connectUserSocket(userId, row, token)
      })().catch(() => {})
    }, delay)
  }

  private async currentToken(userId: string): Promise<string | null> {
    const session = await db.session.findFirst({
      where: { userId, expiresAt: { gt: new Date() }, discordAccessToken: { not: null } },
      orderBy: { createdAt: 'desc' },
    }).catch(() => null)
    return session?.discordAccessToken ?? null
  }

  // ─── Activity builder (reuses the platform's pure payload builder) ────────

  // ─── Task 92 — global display-type assignment (read-only) ─────────────────

  /**
   * Task 92 — THIS system's display type under the GLOBAL orchestration.
   *
   * Discord's client renders at most ONE PLAYING-type card and collapses
   * (type, application_id, name) duplicates (verified in the shipped client
   * bundle 2026-10-14). The main daemon (rpc-daemon.ts) computes the same
   * deterministic assignment over slots + games + THIS row (key "app_rpc",
   * always LAST in the global order), so both processes independently agree.
   * Read-only: two raw SELECTs against RpcConfig/GameConfig + one against
   * GlobalConfig for the Auto-Rotate flag — zero writes to other systems.
   */
  private async resolveDisplayType(row: AppRpcRow): Promise<string> {
    const inputs: DisplayTypeCandidate[] = []
    // Enabled Normal slots first (slot number, then creation — the same order
    // selectActiveRpcConfigs uses on the main-daemon side).
    try {
      const slots = await db.$queryRaw<Array<{ id: string; name: string; appId: string | null; type: string | null }>>`
        SELECT "id", "name", "appId", "type"
        FROM "RpcConfig"
        WHERE "userId" = ${row.userId} AND "enabled" = ${true}
        ORDER BY "slot" ASC, "createdAt" ASC`
      for (const s of slots ?? []) {
        inputs.push({ key: s.id, name: s.name, appId: s.appId ?? null, configuredType: s.type ?? null })
      }
    } catch { /* table/column missing on an old schema — no slots known */ }
    // Enabled Game RPCs (creation order — same as the main daemon's list).
    try {
      const games = await db.$queryRaw<Array<{ id: string; gameName: string }>>`
        SELECT "id", "gameName"
        FROM "GameConfig"
        WHERE "userId" = ${row.userId} AND "enabled" = ${true}
        ORDER BY "createdAt" ASC`
      for (const g of games ?? []) {
        inputs.push({ key: g.id, name: g.gameName, appId: null, configuredType: 'PLAYING' })
      }
    } catch { /* no GameConfig table — skip */ }
    // While Auto Rotate runs, the rotating main session owns the single
    // PLAYING card — this system never presents as PLAYING in that mode.
    let rotateOn = false
    try {
      const rot = await db.$queryRaw<Array<{ rpcAutoRotate: boolean | number }>>`
        SELECT "rpcAutoRotate" FROM "GlobalConfig" WHERE "userId" = ${row.userId} LIMIT 1`
      rotateOn = rot?.[0]?.rpcAutoRotate === true || (rot?.[0]?.rpcAutoRotate as unknown) === 1
    } catch { /* column/table missing — rotation off */ }
    inputs.push({
      key: 'app_rpc',
      name: row.name,
      appId: isUsableApplicationRpcAppId(row.appId) ? row.appId : null,
      configuredType: row.type ?? null,
    })
    const neverPlaying = rotateOn ? new Set(['app_rpc']) : new Set<string>()
    return assignDisplayTypes(inputs, neverPlaying).get('app_rpc') ?? 'PLAYING'
  }

  private async buildActivity(row: AppRpcRow, userAccessToken: string, activityLabel?: string): Promise<Record<string, unknown> | null> {
    const updatedAtMs = row.updatedAt ? new Date(row.updatedAt).getTime() : NaN
    // Task 92 — display type from the GLOBAL orchestration (may differ from
    // the saved row.type when another system owns the single PLAYING card).
    const displayType = await this.resolveDisplayType(row)
    const ctx: PlaceholderContext = {
      timezone: 'UTC',
      rpcStartedAt: Number.isFinite(updatedAtMs) && updatedAtMs > 0 ? updatedAtMs : Date.now(),
    }
    // Timezone-aware placeholders need the user's GlobalConfig — read-only,
    // resolved lazily so users without placeholders never pay for it.
    let globalCfg: { timezone?: string; city?: string | null; tempUnit?: string } | null = null
    if (/\{(time|temp|city|uptime|weather)\}/i.test(`${row.state ?? ''}${row.details ?? ''}`)) {
      globalCfg = await db.globalConfig.findUnique({
        where: { userId: row.userId },
        select: { timezone: true, city: true, tempUnit: true },
      }).catch(() => null)
      if (globalCfg) {
        ctx.timezone = globalCfg.timezone || 'UTC'
        ctx.city = globalCfg.city || undefined
        ctx.tempUnit = globalCfg.tempUnit === 'F' ? 'F' : 'C'
      }
    }
    // Resolve placeholders up-front so the reused builder receives final text.
    const state = await resolvePlaceholders(row.state || '', ctx)
    const details = await resolvePlaceholders(row.details || '', ctx)

    const cfg = {
      // RpcConfig-compatible shape for the shared pure builder.
      name: row.name,
      type: displayType,
      platform: row.platform,
      state,
      details,
      largeImage: row.largeImage,
      largeText: row.largeText,
      smallImage: row.smallImage,
      smallText: row.smallText,
      button1Label: row.button1Label,
      button1Url: row.button1Url,
      button2Label: row.button2Label,
      button2Url: row.button2Url,
      partyCurrent: row.partyCurrent,
      partyMax: row.partyMax,
      startMinsAgo: row.startMinsAgo,
      endTotalMins: row.endTotalMins,
      appId: isUsableApplicationRpcAppId(row.appId) ? row.appId : null,
      updatedAt: row.updatedAt,
    }

    try {
      const built = await buildActivityPayload(cfg as Parameters<typeof buildActivityPayload>[0], ctx, {
        userAccessToken,
      }) as Record<string, unknown>

      // Task 84d rule (live-verified): platform values OUTSIDE Discord's
      // activity enum ('web'/'mobile') get the WHOLE activity silently
      // rejected — drop those. Task 91: a VALID enum label is now REQUIRED —
      // it is the field Discord clients merge profile cards by. The label
      // always matches this session's identify (resolved in maintainUser),
      // mirroring the accepted meta_quest/VR precedent.
      if (built.platform && built.platform !== 'meta_quest') delete built.platform
      if (activityLabel && activityLabel !== 'desktop') {
        built.platform = activityLabel
      }

      const safe = sanitizeActivities([built])
      return safe.length > 0 ? safe[0] : null
    } catch (err) {
      console.error(`[10X RPC AppDaemon] Activity build failed for user ${row.userId}:`, err)
      return null
    }
  }

  // ─── Subscription gate (read-only mirror of the platform's policy) ────────

  private async subscriptionAllows(userId: string, discordId: string): Promise<{ ok: boolean; message: string }> {
    if (CONFIG.admin.discordIds.includes(discordId)) return { ok: true, message: 'admin bypass' }
    try {
      const rows = await db.$queryRaw<AppSubRow[]>`
        SELECT "plan", "status", "trialEndsAt", "currentPeriodEnd"
        FROM "Subscription" WHERE "userId" = ${userId} LIMIT 1`
      const sub = rows?.[0]
      if (!sub) {
        // No subscription row yet (signup race) — allow; the website sweep
        // seeds it and the next tick re-evaluates.
        return { ok: true, message: 'allowed' }
      }
      const now = Date.now()
      if (sub.status === 'trialing') {
        const ok = !!sub.trialEndsAt && new Date(sub.trialEndsAt).getTime() > now
        return ok
          ? { ok: true, message: 'allowed' }
          : { ok: false, message: 'Subscription suspended — renew to restore Application RPC.' }
      }
      if (sub.status === 'active') {
        const ok = sub.plan === 'lifetime' || !sub.currentPeriodEnd || new Date(sub.currentPeriodEnd).getTime() > now
        return ok
          ? { ok: true, message: 'allowed' }
          : { ok: false, message: 'Subscription suspended — renew to restore Application RPC.' }
      }
      return { ok: false, message: 'Subscription suspended — renew to restore Application RPC.' }
    } catch {
      // Table missing on a pre-migration daemon — fail open (same policy as
      // the main daemon's batch loader) so a schema rollout race can never
      // break live presence.
      return { ok: true, message: 'subscription table unavailable' }
    }
  }

  // ─── Socket plumbing ───────────────────────────────────────────────────────

  private ensureSocket(userId: string): AppRpcSocket {
    let sock = this.sockets.get(userId)
    if (!sock) {
      sock = {
        userId,
        ws: null,
        heartbeatAck: true,
        retryCount: 0,
        connected: false,
        isConnecting: false,
      }
      this.sockets.set(userId, sock)
    }
    return sock
  }

  private closeSocket(sock: AppRpcSocket): void {
    if (sock.heartbeatTimer) {
      clearInterval(sock.heartbeatTimer)
      sock.heartbeatTimer = undefined
    }
    if (sock.ws) {
      const ws = sock.ws
      // Never leave the socket listener-less (a close during CONNECTING emits
      // 'error' asynchronously) and never close() a CONNECTING socket.
      try { ws.removeAllListeners() } catch {}
      try { ws.on('error', () => {}) } catch {}
      try {
        if (ws.readyState === WebSocket.OPEN) ws.close()
        else ws.terminate()
      } catch {
        try { ws.terminate() } catch {}
      }
      sock.ws = null
    }
    sock.connected = false
    sock.isConnecting = false
  }

  private cleanupSocket(sock: AppRpcSocket): void {
    if (sock.retryTimer) {
      clearTimeout(sock.retryTimer)
      sock.retryTimer = undefined
    }
    sock.connectingSince = undefined
    sock.lastHeartbeatSentAt = undefined
    this.closeSocket(sock)
  }

  private ensureSocketClosed(userId: string): void {
    const sock = this.sockets.get(userId)
    if (sock) {
      this.cleanupSocket(sock)
      this.sockets.delete(userId)
    }
  }

  /** Stop the user's Application RPC and disable ITS OWN row (sleep timer). */
  private async stopAndDisable(userId: string, message: string): Promise<void> {
    this.ensureSocketClosed(userId)
    try {
      await db.$executeRaw`
        UPDATE "ApplicationRpcConfig"
        SET "enabled" = ${false}, "runState" = ${'idle'}, "runError" = ${null}, "runSinceAt" = ${new Date().toISOString()}
        WHERE "userId" = ${userId}`
    } catch (err) {
      console.warn(`[10X RPC AppDaemon] Disable write failed for user ${userId}:`, err instanceof Error ? err.message : err)
    }
    console.log(`[10X RPC AppDaemon] ${message} (user ${userId})`)
  }

  // ─── Instant sync entrypoint (website saves/toggles → /sync) ──────────────

  /**
   * Re-evaluate ONE user right now. Idempotent and mode-independent: the
   * caller's intent does not matter (this daemon only obeys ITS OWN row's
   * enabled flag) — so a Normal/Game 'stop' notification can never stop the
   * Application RPC, and an Application toggle never touches the others.
   */
  public async syncUser(userId: string): Promise<{ ok: boolean; message: string }> {
    try {
      const row = await this.loadRow(userId)
      if (!row || !row.enabled) {
        this.ensureSocketClosed(userId)
        if (row) await this.transitionRunState(row, 'idle', null)
        return { ok: true, message: row ? 'Application RPC disabled' : 'No Application RPC configuration' }
      }
      await this.maintainUser(row, true)
      return { ok: true, message: 'Application RPC synced' }
    } catch (err) {
      console.error(`[10X RPC AppDaemon] syncUser failed for user ${userId}:`, err)
      return { ok: false, message: 'Application RPC sync failed' }
    }
  }

  /** Health/metrics payload (additive field on the runner's /health). */
  public getStatus() {
    return {
      running: this.isRunning,
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      lastTickAt: this.lastTickAt,
      activeSessions: Array.from(this.sockets.values()).filter(s => s.connected).length,
      totalTrackedUsers: this.sockets.size,
      users: Array.from(this.sockets.values()).map(s => ({
        userId: s.userId,
        connected: s.connected,
        platform: s.identifiedPlatform ?? null,
        lastPushAt: s.lastPushAt ? new Date(s.lastPushAt).toISOString() : null,
      })),
    }
  }

  /** Runtime-state normalization for health consumers. */
  public static normalizeState(v: unknown): string {
    return normalizeRunState(v)
  }
}

// Global singleton — same pattern as the main daemon (survives HMR).
declare global {
  var __applicationRpcDaemonInstance: ApplicationRpcDaemon | undefined
}

export function getApplicationRpcDaemon(): ApplicationRpcDaemon {
  if (!global.__applicationRpcDaemonInstance) {
    global.__applicationRpcDaemonInstance = new ApplicationRpcDaemon()
  }
  return global.__applicationRpcDaemonInstance
}

/** Ensure the Application RPC daemon is running (in-process dev fallback). */
export function ensureApplicationDaemonRunning(): ApplicationRpcDaemon {
  const daemon = getApplicationRpcDaemon()
  daemon.start().catch(err => {
    console.error('[10X RPC AppDaemon] Failed to start daemon:', err)
  })
  return daemon
}
