// 10X RPC — 24/7 Background RPC & Status Daemon
// Maintains persistent Discord Gateway WebSocket connections for all active sessions,
// automatically recovers from drops, refreshes expired OAuth tokens, ticks status rotator,
// updates dynamic placeholders, and enforces sleep timers.

import WebSocket from 'ws'
import { Prisma } from '@prisma/client'
import { CONFIG } from './config'
import { db } from './db'
import {
  buildPresenceActivities,
  buildCustomStatusActivity,
  fetchGameAppId,
  fetchRpcAppIds,
  refreshDiscordToken,
  resolveRuntimeCandidates,
  rpcCandidateKey,
  selectActiveRpcConfigs,
  assignSessionPlatforms,
  assignDisplayTypes,
  discordPlatformClass,
  isValidActivityPlatform,
  type PresenceResult,
  type RpcCandidate,
  type DisplayTypeCandidate,
} from './rpc-manager'
import { resolvePlaceholders, type PlaceholderContext } from './placeholders'
import { sanitizeActivities } from './discord-assets'
import { discordAuthValue } from './discord-auth'
import { buildIdentify } from './gateway-platform'
import { normalizeRotateOrder, type RotateOrder } from './rotation'

// ─── Subscription gate (raw SQL — Orihost-safe) ─────────────────────────────
// Access = plan/status lifecycle: free trial (status "trialing", ends
// trialEndsAt) → paid period (status "active", ends currentPeriodEnd; null or
// plan "lifetime" = never) → "suspended" once the phase ends. Admins bypass.
// Raw SQL on purpose: this file also runs on the standalone Orihost daemon,
// whose generated Prisma client may predate the Subscription model — $queryRaw
// only needs the TABLE to exist (it is pushed by the website's db:push).
interface DaemonSubRow {
  plan: string
  status: string
  trialEndsAt: Date | string | null
  currentPeriodEnd: Date | string | null
}

/** Pure check — is this subscription state allowed to run presence? */
function isDaemonSubAllowed(sub: DaemonSubRow | null | undefined, now: number = Date.now()): boolean {
  if (!sub) return false
  if (sub.status === 'trialing') {
    return !!sub.trialEndsAt && new Date(sub.trialEndsAt).getTime() > now
  }
  if (sub.status === 'active') {
    return sub.plan === 'lifetime' || !sub.currentPeriodEnd || new Date(sub.currentPeriodEnd).getTime() > now
  }
  return false
}

/** Single-user gate: evaluate + transition to suspended + kill session RPC. */
async function daemonSubscriptionCheck(userId: string, discordId: string): Promise<{ ok: boolean; message: string }> {
  if (CONFIG.admin.discordIds.includes(discordId)) return { ok: true, message: 'admin bypass' }
  let rows: DaemonSubRow[] = []
  try {
    rows = await db.$queryRaw<DaemonSubRow[]>`
      SELECT plan, status, "trialEndsAt", "currentPeriodEnd"
      FROM "Subscription" WHERE "userId" = ${userId} LIMIT 1`
    if (rows.length === 0) {
      // Recovery for a user created between signup and subscription creation
      // (tiny race window): seed from the legacy Trial when it still has time,
      // otherwise a fresh 3-day window. Never leave a valid user locked out.
      rows = await db.$queryRaw<DaemonSubRow[]>`
        INSERT INTO "Subscription" ("id","userId","plan","status","trialEndsAt","createdAt","updatedAt")
        SELECT 'sub_' || md5(random()::text || clock_timestamp()::text), u."id",
               'free', 'trialing',
               COALESCE(t."endsAt", NOW() + interval '3 days'),
               NOW(), NOW()
        FROM "User" u LEFT JOIN "Trial" t ON t."userId" = u."id"
        WHERE u."id" = ${userId}
        ON CONFLICT ("userId") DO NOTHING
        RETURNING plan, status, "trialEndsAt", "currentPeriodEnd"`
      if (rows.length === 0) {
        rows = await db.$queryRaw<DaemonSubRow[]>`
          SELECT plan, status, "trialEndsAt", "currentPeriodEnd"
          FROM "Subscription" WHERE "userId" = ${userId} LIMIT 1`
      }
    }
  } catch {
    // Table missing (daemon deployed before the website migration) — fail OPEN
    // so a schema rollout race can never break live presence.
    return { ok: true, message: 'subscription table unavailable' }
  }
  if (isDaemonSubAllowed(rows[0])) return { ok: true, message: 'allowed' }

  // Expired → mark suspended (idempotent) + kill every live session's RPC flags.
  try {
    await db.$executeRaw`
      UPDATE "Subscription"
      SET status = 'suspended', "suspendedAt" = NOW(), "updatedAt" = NOW()
      WHERE "userId" = ${userId} AND status <> 'suspended'`
  } catch { /* best-effort — the check below already denies access */ }
  try {
    await db.session.updateMany({
      where: { userId, expiresAt: { gt: new Date() } },
      data: { rpcEnabled: false, statusEnabled: false, gatewayReady: false, vrStatusActive: false },
    })
  } catch { /* best-effort */ }
  return { ok: false, message: 'Subscription suspended — renew to restore 24/7 RPC' }
}

/** Batch lookup for syncAllUsers (one query per tick instead of one per user). */
async function loadDaemonSubStates(userIds: string[]): Promise<Map<string, DaemonSubRow>> {
  const map = new Map<string, DaemonSubRow>()
  if (userIds.length === 0) return map
  try {
    const rows = await db.$queryRaw<(DaemonSubRow & { userId: string })[]>`
      SELECT "userId", plan, status, "trialEndsAt", "currentPeriodEnd"
      FROM "Subscription" WHERE "userId" IN (${Prisma.join(userIds)})`
    for (const r of rows) map.set(r.userId, r)
  } catch {
    // Fail open (empty map would deny everyone) — treat as "all allowed".
    for (const id of userIds) {
      map.set(id, { plan: 'free', status: 'active', trialEndsAt: null, currentPeriodEnd: null })
    }
  }
  return map
}

// ─── RPC Auto Rotate settings (raw SQL — Orihost-safe) ──────────────────────
// Optional runtime-only rotation across the user's ENABLED RPC candidates.
// Read via $queryRaw because the standalone Orihost daemon's Prisma client may
// predate the rpcAutoRotate/rpcRotateSecs columns — raw SQL only needs the
// COLUMNS to exist (pushed by the website's db:push). Missing columns / table
// → rotation OFF (safe default, nothing else affected).

interface RpcRotateSettings {
  enabled: boolean
  secs: number
  /** Rotation clock anchor (GlobalConfig.updatedAt) — stable across restarts. */
  refMs: number | null
  /** Task 87 — forward | reverse | shuffle. */
  order: RotateOrder
  /** Task 87 — false = the Game RPC stays OUT of the rotation and keeps its
   *  own always-visible session while the slots rotate. */
  includeGame: boolean
  /** Task 87 — manual advance counter ("Skip to next"). */
  skip: number
  /** Task 89 — explicit rotation pool (candidate keys: RpcConfig ids or
   *  "game:<slug>"). null = not set → the legacy includeGame rule applies;
   *  an array = ONLY those candidates take turns in the Auto Rotator. */
  slots: string[] | null
}

const ROTATE_DEFAULTS: RpcRotateSettings = {
  enabled: false,
  secs: 30,
  refMs: null,
  order: 'forward',
  includeGame: true,
  skip: 0,
  slots: null,
}

// ─── Task 92 — Application RPC display-type context (raw SQL, Orihost-safe) ─
// The global display-type assignment (assignDisplayTypes) spans ALL THREE RPC
// systems, so the main daemon must know the Application RPC's saved shape —
// read-only, tolerant of a missing table (pre-Task-90 daemons).
interface AppRpcTypeRow { name: string; appId: string | null; type: string | null }

async function fetchAppRpcTypeRow(userId: string): Promise<AppRpcTypeRow | null> {
  try {
    const rows = await db.$queryRaw<Array<AppRpcTypeRow>>`
      SELECT "name", "appId", "type"
      FROM "ApplicationRpcConfig"
      WHERE "userId" = ${userId} AND "enabled" = ${true}
      LIMIT 1`
    return rows?.[0] ?? null
  } catch {
    return null
  }
}

/** Task 89 — parse the stored rpcRotateSlots JSON column (raw-SQL safe).
 *  Returns null for unset/invalid values (→ legacy includeGame rule) and a
 *  sanitized string[] otherwise (deduped, capped at 12 entries). */
function parseRotateSlots(raw: unknown): string[] | null {
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

async function fetchRpcRotateSettings(userId: string): Promise<RpcRotateSettings> {
  try {
    // Extended read — needs the Task-87 columns. Falls back to the legacy
    // read when the DB predates them (rotation still works: forward order,
    // game included, no skip).
    try {
      const rows = await db.$queryRaw<Array<{
        rpcAutoRotate: boolean | number
        rpcRotateSecs: number | null
        rpcRotateOrder: string | null
        rpcRotateIncludeGame: boolean | number | null
        rpcRotateSkip: number | null
        rpcRotateSlots: string | null
        updatedAt: Date | string
      }>>`
        SELECT "rpcAutoRotate", "rpcRotateSecs", "rpcRotateOrder",
               "rpcRotateIncludeGame", "rpcRotateSkip", "rpcRotateSlots", "updatedAt"
        FROM "GlobalConfig" WHERE "userId" = ${userId} LIMIT 1`
      const r = rows?.[0]
      if (!r) return ROTATE_DEFAULTS
      const inc = r.rpcRotateIncludeGame
      return {
        enabled: r.rpcAutoRotate === true || (r.rpcAutoRotate as unknown) === 1,
        secs: Math.max(15, Math.min(3600, Number(r.rpcRotateSecs ?? 30) || 30)),
        refMs: r.updatedAt ? new Date(r.updatedAt).getTime() : null,
        order: normalizeRotateOrder(r.rpcRotateOrder),
        includeGame: inc !== false && (inc as unknown) !== 0,
        skip: Math.max(0, Math.min(1_000_000_000, Math.floor(Number(r.rpcRotateSkip) || 0))),
        slots: parseRotateSlots(r.rpcRotateSlots),
      }
    } catch (legacyErr) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn(`[10X RPC Daemon] rotate settings extended read failed for ${userId}, legacy fallback:`, legacyErr instanceof Error ? legacyErr.message : legacyErr)
      }
      const rows = await db.$queryRaw<Array<{ rpcAutoRotate: boolean | number; rpcRotateSecs: number | null; updatedAt: Date | string }>>`
        SELECT "rpcAutoRotate", "rpcRotateSecs", "updatedAt"
        FROM "GlobalConfig" WHERE "userId" = ${userId} LIMIT 1`
      const r = rows?.[0]
      if (!r) return ROTATE_DEFAULTS
      return {
        ...ROTATE_DEFAULTS,
        enabled: r.rpcAutoRotate === true || (r.rpcAutoRotate as unknown) === 1,
        secs: Math.max(15, Math.min(3600, Number(r.rpcRotateSecs ?? 30) || 30)),
        refMs: r.updatedAt ? new Date(r.updatedAt).getTime() : null,
      }
    }
  } catch (rotateErr) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`[10X RPC Daemon] rotate settings read failed for ${userId} (rotation OFF):`, rotateErr instanceof Error ? rotateErr.message : rotateErr)
    }
    return ROTATE_DEFAULTS
  }
}

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
  /** Signature of the last Discord presence echo (name:type list) — dedupes
   *  the PRESENCE_UPDATE diagnostic log. */
  lastEchoSig?: string
  connected: boolean
  lastConnectedAt?: Date
  isConnecting: boolean
  connectingSince?: number
  lastPushAt?: number
  /** Token sent with the last IDENTIFY — lets the close handler remember
   *  exactly which token Discord rejected. */
  identifiedWith?: string | null
  /** Platform whose properties were sent with the CURRENT socket's IDENTIFY.
   *  Discord derives the "Active on Mobile / Meta Quest / Desktop" badge from
   *  these IDENTIFY properties — OP 3 can NOT change it. When the desired
   *  platform differs from this value the socket must be re-identified
   *  (fresh gateway connection) for VR / mobile status to switch instantly. */
  identifiedPlatform?: string
  /** The Discord token whose IDENTIFY was rejected with 4004 (Authentication
   *  failed). 4004 means the token ITSELF is dead (revoked/reset) — retrying
   *  the same token hits 4004 forever. Auth stays fatal until the stored
   *  token CHANGES (re-login / new token), which auto-unblocks the user. */
  failedAuthToken?: string | null
}

// ─── MULTI-SESSION RUNTIME (Task 84 — “3 RPCs at the same time”) ───────────
// A single gateway session renders exactly ONE activity card on Discord —
// sending 3 activities in one OP 3 gets collapsed to one by the client
// (verified live 2026-10-13). Discord's social layer DOES aggregate
// activities from SEPARATE concurrent sessions (that is how a desktop game
// + Spotify + a console session all appear at once), and the Gaming SDK
// gateway accepts several concurrent sessions per OAuth token (verified:
// 5 simultaneous READYs, no 4003s). So in SIMULTANEOUS mode with 2+ enabled
// candidates, every candidate beyond the first gets its OWN extra gateway
// session that pushes exactly that one activity — giving each enabled RPC
// its own presence source so Discord can display them together.
// Auto Rotate keeps the single-session behavior (one activity at a time, by
// design). Extras are runtime-only: they never read/write saved configs.
interface SlotSession {
  /** Stable candidate identity (RpcConfig id or game:<slug>). */
  key: string
  ws: WebSocket | null
  heartbeatTimer?: NodeJS.Timeout
  heartbeatAck: boolean
  lastHeartbeatSentAt?: number
  connected: boolean
  isConnecting: boolean
  identifiedPlatform?: string
  /** Signature of the activity this session was opened with. */
  lastActivityHash: string
  /** The activity payload this session pushed (for status re-pushes). */
  lastActivity: Record<string, unknown> | null
  lastPushedStatus?: string
  failCount: number
  lastFailAt?: number
  /** Set when the session was closed before/while connecting (deferred
   *  staggered connects check this so a stale timer never reconnects). */
  aborted: boolean
}

export class RpcDaemon {
  private sockets = new Map<string, ActiveUserSocket>()
  /** Multi-Session extras: userId → (candidate key → session). */
  private slotSessions = new Map<string, Map<string, SlotSession>>()
  /** Token fingerprint each user's extras were opened with (reopen on refresh). */
  private slotSessionsToken = new Map<string, string>()
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

    // Tick every 10 seconds — Auto Rotate buckets start at 30s, so a 30s tick
    // raced the rotation clock (bucket jitter skipped slots or double-showed
    // one). 10s gives ≤10s rotation accuracy and propagates saves faster.
    this.tickTimer = setInterval(async () => {
      try {
        await this.tick()
      } catch (err) {
        console.error('[10X RPC Daemon] Tick error:', err)
      }
    }, 10000)

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
              },
            },
          },
        })

        if (!session) {
          this.disconnectUser(userId)
          continue
        }

        // Subscription gate — 3-day free trial / paid period → suspended when
        // the phase ends. Admins bypass. Also transitions + kills session RPC.
        const subCheck = await daemonSubscriptionCheck(userId, session.user.discordId)
        if (!subCheck.ok) {
          console.log(`[10X RPC Daemon] Subscription suspended for user ${userId}, disabling presence`)
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

    // Subscription states for everyone in this pass — one raw query (Orihost-safe).
    const subStates = await loadDaemonSubStates(
      [...new Set(activeSessions.map((s: { userId: string }) => s.userId))] as string[],
    )

    const activeUserIds = new Set<string>()

    // Latest session per user. Auth-fatal (4004) decisions must compare against
    // the SAME session the connector uses (latest = createdAt desc) — a user can
    // hold several session rows with different tokens, and comparing against a
    // stale row would unblock the guard every tick and resurrect the 4004 loop.
    const latestTokenByUser = new Map<string, string | null>()
    for (const s of activeSessions) {
      if (!latestTokenByUser.has(s.userId)) latestTokenByUser.set(s.userId, s.discordAccessToken || null)
    }

    // ── MULTI-SESSION / STABILITY FIX (Task 84) ────────────────────────────
    // Iterate ONE (latest) session PER USER — not every session row. A user
    // with 2 valid session rows (different tokens) used to be processed TWICE
    // per tick with ALTERNATING tokens, which (a) flip-flopped the platform
    // target into an endless re-identify loop and (b) tore down + reopened
    // every Multi-Session extra every tick (token-fingerprint guard) — the
    // "OP 9 storm / extra sessions never stable" bug.
    const latestSessionByUser = new Map<string, typeof activeSessions[number]>()
    for (const s of activeSessions) {
      if (!latestSessionByUser.has(s.userId)) latestSessionByUser.set(s.userId, s)
    }

    for (const session of latestSessionByUser.values()) {
      // Subscription gate — expired trial/period users are not tracked (the
      // tick loop + website sweeps transition them to "suspended"). Admins bypass.
      if (!CONFIG.admin.discordIds.includes(session.user.discordId) &&
          !isDaemonSubAllowed(subStates.get(session.userId))) {
        continue
      }
      // Check sleep timer
      if (session.sleepTimerActive && session.sleepTimerEndsAt && session.sleepTimerEndsAt <= now) {
        continue
      }

      const rpcConfigs = (session.user.rpcConfigs ?? []) as Array<RpcCandidate & { enabled: boolean }>
      // Task 89 — MULTI-GAME: every enabled game is a candidate (array form),
      // so several Gamer RPCs run at the same time alongside the slots.
      // Task 92 — deterministic createdAt order (the relation include has no
      // orderBy; the display-type orchestration requires BOTH daemons to see
      // the SAME candidate order).
      const enabledGames = (session.user.gameConfigs ?? [])
        .filter(g => g.enabled)
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      // MULTI-RPC: every enabled slot (each with its own flag) + every enabled
      // game are candidates. No mode exclusivity — combinations are supported.
      const selection = selectActiveRpcConfigs(session.rpcEnabled, rpcConfigs, enabledGames)
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
          platform: selection.candidates[0]?.platform || 'desktop',
          lastStatus: session.userStatus || 'online',
          lastActivitiesHash: '',
          connected: false,
          isConnecting: false,
        }
        this.sockets.set(session.userId, userSock)
      }

      // If socket is disconnected, connect it; if connected, re-push the
      // CURRENT DB state. ── STATUS-NOT-UPDATING FIX: the tick previously
      // only connected/disconnected sockets and NEVER re-pushed presence for
      // already-connected users. Any instant-sync that died before its OP 3
      // landed (the recurring "Can't reach database server" bursts inside
      // pushPresenceForUser, a lost /sync proxy request, a change made while
      // a socket was still connecting) was therefore lost FOREVER — the
      // website told the user "daemon tick will retry within 30s" but the
      // tick had no retry path. pushPresenceForUser is hash-guarded, so an
      // unchanged state sends nothing (no OP 3 spam, no rate limits); a
      // state whose push failed re-sends here within 30s.
      if (!userSock.connected && !userSock.isConnecting) {
        // Auth-fatal guard (4004): skip while the FAILED token is still the
        // user's LATEST token; auto-unblock as soon as a new token lands.
        if (userSock.failedAuthToken) {
          if (userSock.failedAuthToken === (latestTokenByUser.get(session.userId) ?? null)) continue
          userSock.failedAuthToken = null // new token — allow a fresh attempt
        }
        this.connectUserSocket(session.userId)
      } else if (userSock.connected) {
        void this.pushPresenceForUser(session.userId, session, false).catch(() => {})
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

    if (userSock && userSock.ws && userSock.ws.readyState === WebSocket.OPEN && userSock.connected) {
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

    // Subscription gate — 3-day free trial / paid period → suspended.
    const subCheck = await daemonSubscriptionCheck(userId, session.user.discordId)
    if (!subCheck.ok) {
      this.disconnectUser(userId)
      return {
        ok: false,
        method: 'none',
        message: subCheck.message,
      }
    }

    const rpcConfigs = (await db.rpcConfig.findMany({
      where: { userId },
      // NOTE: createdAt order only — NO `slot` orderBy here. The standalone
      // Orihost daemon's Prisma client may predate the slot column and an
      // unknown orderBy argument would throw on EVERY call. Insertion order
      // == slot order (slots are normalized by createdAt on the website).
      orderBy: { createdAt: 'asc' },
    }).catch(async () => {
      // Legacy-client fallback: findFirst (pre-slot clients know it) keeps
      // the user's primary slot alive if findMany ever fails.
      const r = await db.rpcConfig.findFirst({ where: { userId } }).catch(() => null)
      return r ? [r as RpcCandidate] : []
    })) as Array<RpcCandidate & { enabled: boolean }>
    // Task 89 — MULTI-GAME: every enabled game runs as its own candidate.
    const enabledGames = await db.gameConfig.findMany({ where: { userId, enabled: true }, orderBy: { createdAt: 'asc' } })
    // MULTI-RPC: all enabled slots + ALL enabled games (no mode exclusivity).
    const selection = selectActiveRpcConfigs(session.rpcEnabled, rpcConfigs, enabledGames)
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
        platform: selection.candidates[0]?.platform || 'desktop',
        lastStatus: session.userStatus || 'online',
        lastActivitiesHash: '',
        connected: false,
        isConnecting: false,
      }
      this.sockets.set(userId, userSock)
    }

    // INSTANT-UPDATE FIX (VR / mobile status not applying right away):
    // an explicit user action must never be silently dropped. Previously:
    //   • a socket stuck "connecting" (or waiting on a retry backoff timer)
    //     made syncUser a no-op — the save waited for the next tick or the
    //     backoff (up to 60s);
    //   • a socket flagged connected but half-open/closed silently swallowed
    //     the push (pushPresenceForUser returns on non-OPEN readyState).
    if (!userSock.connected || !userSock.ws || userSock.ws.readyState !== WebSocket.OPEN) {
      // Half-open / closed / connecting — force a clean reconnect path.
      if (userSock.connected || userSock.ws) this.cleanupSocket(userSock)
      // The user just acted: supersede any scheduled backoff retry.
      if (userSock.retryTimer) {
        clearTimeout(userSock.retryTimer)
        userSock.retryTimer = undefined
      }
      if (!userSock.isConnecting) await this.connectUserSocket(userId)
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

      // Check target platform based on the active candidates (Normal slots vs
      // Gamer RPC are no longer exclusive — the socket platform follows the
      // FIRST candidate so rotation between slots never flips the badge).
      const rpcConfigs = (await db.rpcConfig.findMany({
        where: { userId },
        // createdAt order only — never orderBy `slot` (old daemon clients).
        orderBy: { createdAt: 'asc' },
      }).catch(async () => {
        const r = await db.rpcConfig.findFirst({ where: { userId } }).catch(() => null)
        return r ? [r as RpcCandidate] : []
      })) as Array<RpcCandidate & { enabled: boolean }>
      // Task 89 — MULTI-GAME: every enabled game runs as its own candidate.
      const enabledGames = await db.gameConfig.findMany({ where: { userId, enabled: true }, orderBy: { createdAt: 'asc' } }).catch(() => [])
      const selection = selectActiveRpcConfigs(session.rpcEnabled, rpcConfigs, enabledGames)
      const isRpcActive = selection.active
      const isStatusActive = !!session.statusEnabled

      const activePlatform = isStatusActive
        ? (session.statusPlatform || 'mobile')
        : (isRpcActive ? (selection.candidates[0]?.platform || 'desktop') : (session.statusPlatform || 'mobile'))

      const isQuest = activePlatform === 'meta_quest' || (isStatusActive && session.vrStatusActive)
      const targetPlatform = isQuest ? 'meta_quest' : activePlatform
      userSock.platform = targetPlatform
      userSock.identifiedPlatform = targetPlatform

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

            // Full official-client properties per platform — the platform badge
            // (Active on Mobile / VR headset / console gamepad) is derived from
            // these by Discord's server. Minimal 3-field sets never produced a
            // badge, and `capabilities` must NEVER be sent (the 4097 bitmask
            // makes Discord kill the session ~5s after READY — see
            // gateway-platform.ts header).
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

            // Push current presence immediately — ALWAYS from a FRESH DB read:
            // the connect-time snapshot can be seconds old, so a save that
            // landed while the socket was connecting must not wait for the
            // next 30s tick to appear on Discord.
            const freshSession = await db.session.findFirst({
              where: {
                userId,
                expiresAt: { gt: new Date() },
                discordAccessToken: { not: null },
              },
              orderBy: { createdAt: 'desc' },
            }).catch(() => null)
            if (freshSession) {
              await this.pushPresenceForUser(userId, freshSession, true)
            }
          } else if (op === 0 && t === 'PRESENCE_UPDATE') {
            // Task 84d — filter to the user's OWN presence echo. Unfiltered,
            // this logged "Discord accepted 0 activities" noise for every
            // other guild member whose presence changed.
            const echoUserId = (payload.d as { user?: { id?: string } } | undefined)?.user?.id
            if (echoUserId === userId) {
              // Discord's echo of the presence we pushed — the authoritative
              // answer to "what did Discord actually ACCEPT?". Logged on change
              // so multi-RPC truncation (3 sent → N kept) is visible in the
              // console instead of being a silent client-side mystery.
              try {
                const acts = (payload.d as { activities?: Array<{ name?: string; type?: number }> } | undefined)?.activities
                if (Array.isArray(acts)) {
                  const sig = acts.map(a => `${a.name ?? '?'}:${a.type ?? '?'}`).join('|')
                  if (sig !== userSock.lastEchoSig) {
                    userSock.lastEchoSig = sig
                    console.log(`[10X RPC Daemon] Discord accepted ${acts.length} activit${acts.length === 1 ? 'y' : 'ies'} for user ${userId}: [${sig}]`)
                  }
                }
              } catch {}
            }
          } else if (op === 7) {
            // Discord requested reconnect
            console.log(`[10X RPC Daemon] Discord Gateway sent OP 7 RECONNECT for user ${userId}. Reconnecting...`)
            this.cleanupSocket(userSock)
            this.scheduleReconnect(userId, 1000)
          } else if (op === 9) {
            // Invalid session. Discord sends OP 9 when it refuses the identify
            // (rate/abuse flag, session churn). Retrying on a FIXED 3s timer
            // amplified flags into an identify storm (each retry counted as
            // more churn → more OP 9s → 4003 loops). Use the standard
            // exponential backoff so repeated OP 9s space out instead.
            console.warn(`[10X RPC Daemon] Discord Gateway sent OP 9 INVALID_SESSION for user ${userId}`)
            this.cleanupSocket(userSock)
            this.scheduleReconnect(userId)
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

    const delay = customDelayMs ?? Math.min(30000, Math.max(3000, 1000 * Math.pow(1.5, Math.min(userSock.retryCount, 8))))
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
    // Authenticated-only guard: pushing OP 3 into an OPEN-but-not-yet-READY
    // socket (still identifying, or stuck under a Discord OP 9 flag) makes
    // Discord close it with 4003 "Not authenticated" — which used to feed a
    // reconnect storm. The READY handler always pushes fresh DB state right
    // after authentication, so skipping here loses nothing.
    if (!userSock.connected) {
      if (force) console.log(`[10X RPC Daemon] Skipping OP 3 for user ${userId}: socket not authenticated yet (will push on READY)`)
      return
    }

    type GlobalCfgRow = Awaited<ReturnType<typeof db.globalConfig.findUnique>>
    type GameCfgRow = Awaited<ReturnType<typeof db.gameConfig.findFirst>>
    let rpcConfigs: Array<RpcCandidate & { enabled: boolean; updatedAt?: Date }> = []
    let globalConfig: GlobalCfgRow = null
    let enabledGames: GameCfgRow[] = []
    try {
      const [rpc, glob, games] = await Promise.all([
        // createdAt order only — never orderBy `slot` (old daemon clients).
        // A DB failure here must NEVER be read as "no slots" — that would
        // clear the user's live presence; bail out and retry next tick.
        db.rpcConfig.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
        db.globalConfig.findUnique({ where: { userId } }),
        // Task 89 — MULTI-GAME: every enabled game is a live candidate.
        db.gameConfig.findMany({ where: { userId, enabled: true }, orderBy: { createdAt: 'asc' } }),
      ])
      rpcConfigs = rpc as Array<RpcCandidate & { enabled: boolean }>
      globalConfig = glob
      enabledGames = (games ?? []) as GameCfgRow[]
    } catch (dbErr) {
      console.warn(`[10X RPC Daemon] Transient DB error in pushPresenceForUser for user ${userId}:`, dbErr)
      return
    }

    // AUTO ROTATE settings (raw SQL — Orihost-safe, missing columns → OFF).
    const rotate = await fetchRpcRotateSettings(userId)

    const placeholderCtx: PlaceholderContext = {
      timezone: globalConfig?.timezone || 'UTC',
      city: globalConfig?.city || undefined,
      tempUnit: globalConfig?.tempUnit === 'F' ? 'F' : 'C',
      rpcStartedAt: (rpcConfigs[0]?.updatedAt || enabledGames[0]?.updatedAt)
        ? new Date((rpcConfigs[0]?.updatedAt || enabledGames[0]?.updatedAt) as Date).getTime()
        : (session.lastPresenceUpdate ? new Date(session.lastPresenceUpdate).getTime() : Date.now()),
    }

    // MULTI-RPC — all enabled slots (each with its own flag) + ALL enabled
    // games (Task 89 multi-game). resolveRuntimeCandidates applies the
    // OPTIONAL Auto Rotate overlay: simultaneous (default) sends every
    // candidate in one authorized OP 3; rotate sends exactly one, advancing
    // every interval. Rotation is runtime-only — no config is read-write here.
    const fullSelection = selectActiveRpcConfigs(session.rpcEnabled, rpcConfigs, enabledGames)
    const runtime = resolveRuntimeCandidates({
      rpcEnabled: session.rpcEnabled,
      rpcConfigs,
      enabledGame: enabledGames,
      autoRotate: rotate.enabled,
      rotateSecs: rotate.secs,
      rotateRefMs: rotate.refMs,
      rotateOrder: rotate.order,
      rotateSkip: rotate.skip,
      rotateIncludeGame: rotate.includeGame,
      rotateSlotKeys: rotate.slots,
      rotateSeed: userId,
    })
    const isRpcActive = runtime.active
    const isStatusActive = !!session.statusEnabled

    // Socket platform follows the FIRST full-list candidate (rotate-invariant:
    // rotating between slots must never flip the IDENTIFY badge or churn the
    // socket). Status-active keeps its existing precedence.
    const activePlatform = isStatusActive
      ? (session.statusPlatform || 'mobile')
      : (isRpcActive ? (fullSelection.candidates[0]?.platform || 'desktop') : (session.statusPlatform || 'mobile'))
    // Same VR/platform unification as connectUserSocket — the IDENTIFY
    // properties and the OP 3 payload must always agree.
    const isQuest = activePlatform === 'meta_quest' || (isStatusActive && session.vrStatusActive)
    const targetPlatform = isQuest ? 'meta_quest' : activePlatform

    // ════════════════════════════════════════════════════════════════════
    // PLATFORM-INSTANT-UPDATE FIX (the "VR / mobile status not updating"
    // bug): Discord derives the profile's "Active on Mobile / Meta Quest /
    // Desktop" badge from the session's IDENTIFY properties — an OP 3
    // presence update can NOT change it. This method previously just
    // overwrote userSock.platform and kept pushing OP 3 on the SAME socket,
    // so switching Mobile ↔ Meta Quest (VR) ↔ Desktop/Console/Web changed
    // nothing on Discord until an unrelated reconnect happened. Detect the
    // change here and re-identify with a fresh gateway connection: the new
    // IDENTIFY carries the new platform properties and the READY push lands
    // the current presence — the badge flips in ~1s, instantly.
    // ════════════════════════════════════════════════════════════════════
    if (userSock.connected && userSock.identifiedPlatform && userSock.identifiedPlatform !== targetPlatform) {
      console.log(`[10X RPC Daemon] Platform change for user ${userId}: ${userSock.identifiedPlatform} -> ${targetPlatform} — re-identifying gateway session`)
      // Extras re-identify on the next maintenance pass too.
      this.closeAllSlotSessions(userId)
      this.cleanupSocket(userSock)
      userSock.retryCount = 0
      if (userSock.retryTimer) {
        clearTimeout(userSock.retryTimer)
        userSock.retryTimer = undefined
      }
      await this.connectUserSocket(userId)
      return
    }
    userSock.platform = targetPlatform

    // The GAME candidates (isolated Game RPCs) may each carry a custom
    // Application ID ("Add Games") — spoof that application. While rotating,
    // candidates EXCLUDED from the active pool are not in runtime.candidates —
    // resolve their app ids from the FULL list so their pinned extra sessions
    // work.
    // Task 89b — "only the RPCs I select participate in the Auto Rotator":
    // the rotation POOL takes turns in the MAIN session, and every ENABLED
    // candidate the user left OUT of the pool (games AND slots) keeps its own
    // always-visible extra session. This one rule also reproduces the legacy
    // Task-87 behavior when no explicit selection is stored:
    //   • includeGame=true  → pool = everything → nothing left out (no extras)
    //   • includeGame=false → pool = slots      → the games stay visible
    const rotatePoolKeySet = new Set(runtime.rotatePoolKeys ?? [])
    const rotateGameExtras: RpcCandidate[] = isRpcActive && runtime.runtimeMode === 'rotate'
      ? fullSelection.candidates.filter(c => !rotatePoolKeySet.has(rpcCandidateKey(c)))
      : []
    const gameCandidates = [...runtime.candidates.filter(c => c.gameSlug), ...rotateGameExtras]
    for (const gc of gameCandidates) {
      if (gc.gameSlug && !gc.gameAppId) {
        gc.gameAppId = await fetchGameAppId(userId, gc.gameSlug)
      }
    }

    // Per-slot Application ID fallbacks (their own Discord apps) — queryRaw
    // per-row map keeps this working even when this process runs a Prisma
    // client generated before the RpcConfig.appId/slot columns existed.
    const rpcAppIdMap = await fetchRpcAppIds(userId)

    // ── MULTI-SESSION (Task 84 — "3 RPCs at the same time") ────────────────
    // ONE gateway session renders exactly ONE activity card on Discord
    // (3 activities in a single OP 3 collapse to one — verified live), while
    // Discord's social layer aggregates activities from SEPARATE concurrent
    // sessions (how desktop game + Spotify + console presences coexist).
    // In simultaneous mode with 2+ enabled candidates every candidate beyond
    // the first gets its OWN extra session pushing exactly that activity.
    const multiSessionActive = isRpcActive
      && runtime.runtimeMode === 'simultaneous'
      && runtime.candidates.length >= 2
    // Task 87/89 — rotate mode with candidates EXCLUDED from the pool (the
    // explicit selection, or legacy includeGame=false): every excluded
    // candidate keeps its own always-visible extra session while the pool
    // rotates in the main session.
    const rotateGameExtraActive = isRpcActive
      && runtime.runtimeMode === 'rotate'
      && rotateGameExtras.length > 0

    // ── Task 92 — GLOBAL DISPLAY-TYPE ORCHESTRATION (the "only one RPC
    // shows" fix) ────────────────────────────────────────────────────────────
    // Discord's client prunes the profile activity list: at most ONE
    // PLAYING-type card renders and (type, application_id, name) duplicates
    // collapse (verified in the shipped client bundle 2026-10-14 — see
    // rpc-manager.assignDisplayTypes). Assign display types across ALL THREE
    // systems (slots + games + Application RPC) so every simultaneous card
    // survives the client-side prune. Deterministic from saved configs → both
    // daemons independently reach the same assignment.
    if (isRpcActive) {
      const appRpcRow = await fetchAppRpcTypeRow(userId)
      const globalTypeInputs: DisplayTypeCandidate[] = [
        ...fullSelection.candidates.map(c => ({
          key: rpcCandidateKey(c),
          name: c.name,
          appId: c.gameSlug ? null : (c.appId ?? null),
          configuredType: c.type ?? null,
        })),
        ...(appRpcRow ? [{
          key: 'app_rpc',
          name: appRpcRow.name,
          appId: appRpcRow.appId,
          configuredType: appRpcRow.type,
        }] : []),
      ]
      if (multiSessionActive) {
        const displayTypes = assignDisplayTypes(globalTypeInputs)
        for (const c of runtime.candidates) {
          const t = displayTypes.get(rpcCandidateKey(c))
          if (t && t !== c.type) c.type = t
        }
      } else if (rotateGameExtraActive) {
        // Rotate mode: the rotating main session owns the single PLAYING card.
        // Pinned extras (and the Application RPC — it enforces the same rule
        // via GlobalConfig.rpcAutoRotate) never present as PLAYING.
        const neverPlaying = new Set<string>(rotateGameExtras.map(c => rpcCandidateKey(c)))
        if (appRpcRow) neverPlaying.add('app_rpc')
        const displayTypes = assignDisplayTypes(globalTypeInputs, neverPlaying)
        for (const c of rotateGameExtras) {
          const t = displayTypes.get(rpcCandidateKey(c))
          if (t && t !== c.type) c.type = t
        }
      }
    }

    // Task 85 — NO Application-ID shell overlay: normal slots present under
    // the user's custom Application ID or the 10X RPC application (game ids
    // are reserved for the isolated Game RPC). Discord renders one card per
    // (platform class, application id) pair, and every simultaneous session
    // already gets a DISTINCT platform class (Task 84c/84d) — so same-default
    // slots still render side by side without any game-id re-identification.

    const extras: Array<{ idx: number; key: string; label: string; platform: string; activity: Record<string, unknown>; configHash: string }> = []
    // Task 84d — candidates that could NOT get their own extra session (no
    // free platform class, build failure, empty activity) are appended to the
    // MAIN push as a fold-back so they never vanish entirely.
    const mainFallback: typeof runtime.candidates = []
    // Task 84d — STABLE per-candidate class anchor. The Orihost daemon's
    // Prisma client may predate the `slot` column (candidate.slot undefined
    // there — live-verified: every hint collapsed to pool[0] and toggling a
    // middle slot reshuffled the others into reopen churn + zombie sessions).
    // The FULL rpcConfigs list (all rows, createdAt == slot order) gives the
    // same stable position using ids only: slot2 → pool[0], slot3 → pool[1],
    // slot4 → pool[2], slot5 → pool[3]; game/unknown → pool[0].
    const allConfigIndex = new Map<string, number>()
    ;(rpcConfigs as Array<{ id?: string }>).forEach((row, idx) => {
      if (row?.id) allConfigIndex.set(row.id, idx)
    })
    const stableHintOf = (c: RpcCandidate): number => {
      if (typeof c.slot === 'number' && c.slot >= 2) return c.slot - 2
      const idx = c.id ? allConfigIndex.get(c.id) : undefined
      return typeof idx === 'number' && idx >= 1 ? idx - 1 : 4
    }
    // Task 87/89 — the extra-session SOURCE list. Simultaneous mode: every
    // candidate beyond the first (existing Task 84 behavior — slots AND
    // games). Rotate mode with games EXCLUDED from the pool: exactly the
    // pinned game candidates — they stay visible in their own sessions while
    // the pool rotates in the main session.
    interface ExtraSource { cand: RpcCandidate; hint: number }
    const extrasSource: ExtraSource[] = multiSessionActive
      ? runtime.candidates.slice(1, 5).map(cand => ({ cand, hint: stableHintOf(cand) }))
      : rotateGameExtraActive
        ? rotateGameExtras.slice(0, 4).map(cand => ({ cand, hint: stableHintOf(cand) }))
        : []
    if (extrasSource.length > 0) {
      const globalVr = (isStatusActive && (session.statusPlatform === 'meta_quest' || session.vrStatusActive)) || (isRpcActive && fullSelection.candidates[0]?.platform === 'meta_quest')
      const globalPlatform = isRpcActive ? (fullSelection.candidates[0]?.platform || 'desktop') : targetPlatform
      // Task 84c/84d — every extra session gets a DISTINCT platform class (the
      // merge key Discord uses for concurrent sessions; two sessions of the
      // same class overwrite each other and only one card renders). The pool
      // (web → ps4 → android → desktop) avoids classes the user's REAL clients
      // occupy (phone = mobile, desktop app = desktop).
      // 5 classes total = main + 4 extras max.
      const platformAssignments = assignSessionPlatforms(
        targetPlatform,
        extrasSource.map(e => e.cand.platform),
        // Task 84d — STABLE per-candidate hints (see allConfigIndex above):
        // toggling a middle slot never reshuffles the others (no reopen
        // churn / zombie sessions / card flicker).
        extrasSource.map(e => e.hint)
      )
      for (let i = 0; i < extrasSource.length && extras.length < 4; i++) {
        const cand = extrasSource[i].cand
        const assignedPlatform = platformAssignments[i]
        if (!assignedPlatform) {
          // No free platform class — in simultaneous mode fold back into the
          // main push so the candidate never vanishes. In rotate+game-pinned
          // mode there is no fold-back (the game is intentionally NOT in the
          // main rotation push) — it just waits for the next tick's retry.
          if (multiSessionActive) mainFallback.push(cand)
          continue
        }
        try {
          const built = await buildPresenceActivities({
            rpcConfigs: [cand],
            customStatus: null,
            placeholderCtx,
            vrStatusActive: globalVr,
            platform: globalPlatform,
            userAccessToken: session.discordAccessToken,
            rpcAppIdMap,
          })
          const safe = sanitizeActivities(built as Array<Record<string, unknown>>)
          if (safe.length === 0) {
            if (multiSessionActive) mainFallback.push(cand)
          }
          if (safe.length > 0) {
            // Task 84d — CRITICAL: do NOT set a `platform` field inside the
            // activity payload. Isolated via probe10 (SESSIONS_REPLACE live
            // readout): a web-class session's activity WITH platform:'web'
            // was silently REJECTED by Discord (never stored in the user's
            // presence), while the IDENTICAL activity WITHOUT the field was
            // accepted instantly. The session's IDENTIFY properties already
            // carry the platform — the activity-level field only gets the
            // card dropped ('web'/'mobile' rejected; inconsistent with the
            // gateway-classified session). Cards inherit the session's
            // platform label from the identify, which is what we want.
            // Task 91 — REVERSED (live-verified): the client merges rendered
            // profile cards by the ACTIVITY's `platform` field, NOT the
            // session's gateway class. Three extras on web/android/embedded
            // sessions all arrived label-less → Discord stamped every one
            // 'desktop' → all three collapsed into ONE card (and the real
            // desktop client wiped that label group). Every extra now stamps
            // its activity with its ASSIGNED platform — the pool exclusively
            // contains valid activity-enum values (ps4/xbox/android/ios), so
            // every card carries a UNIQUE label and can neither merge with a
            // sibling nor be wiped by a real client's push.
            // STABLE config hash — the session reopen guard. Resolved activities
            // churn every tick (dynamic placeholders), the row's fields don't.
            // Includes the ASSIGNED platform: a class reassignment reopens.
            const configHash = JSON.stringify({
              n: cand.name, t: cand.type, p: cand.platform,
              s: cand.state ?? null, d: cand.details ?? null,
              li: cand.largeImage ?? null, lt: cand.largeText ?? null,
              si: cand.smallImage ?? null, st: cand.smallText ?? null,
              b1: cand.button1Label ?? null, b1u: cand.button1Url ?? null,
              b2: cand.button2Label ?? null, b2u: cand.button2Url ?? null,
              pc: cand.partyCurrent ?? null, pm: cand.partyMax ?? null,
              pi: cand.partyId ?? null, psec: cand.partySecret ?? null,
              sa: cand.startMinsAgo ?? null, et: cand.endTotalMins ?? null,
              ap: cand.appId ?? null, gid: cand.gameSlug ?? null,
              gap: cand.gameAppId ?? null,
              u: (cand as { updatedAt?: unknown }).updatedAt ?? null,
              pl: assignedPlatform,
            })
            // Task 91 — stamp the activity-level platform label (the card
            // merge key). The assigned platform always comes from the
            // Task 91 pool (valid activity-enum values only). A candidate
            // whose builder already set a label (VR meta_quest) gets
            // overridden — the assignment is the single source of truth for
            // extras; two meta_quest-labeled cards would merge client-side.
            if (isValidActivityPlatform(assignedPlatform)) {
              safe[0].platform = assignedPlatform
            }
            extras.push({
              idx: multiSessionActive ? i + 1 : 0,
              key: rpcCandidateKey(cand) || `slot${i + 1}`,
              label: String((safe[0] as { name?: string }).name ?? cand.name ?? `RPC ${i + 1}`),
              platform: assignedPlatform,
              activity: safe[0],
              configHash,
            })
          }
        } catch {
          // One broken candidate must never break the others — fold it back
          // into the main push (best effort) and keep going.
          mainFallback.push(cand)
        }
      }
    }
    // Task 84d — MAIN-SESSION PAYLOAD RESTRUCTURE (the decisive 3-card fix):
    // Discord renders ONE activity card per gateway session (the session's
    // top activity), and merges concurrent sessions PER PLATFORM CLASS with
    // last-write-wins. Verified live via the SESSIONS_REPLACE observer:
    // the main session's 3-activity array was fully ACCEPTED server-side
    // (aggregate showed 4 activities) yet only the top one ever rendered —
    // while duplicates of the same slot (main array + its extra session)
    // collapsed into one card and a dead extra left its slot invisible.
    // Therefore the main session now pushes EXACTLY candidate #1; every
    // further candidate renders exclusively through its own extra session.

    const mainPushCandidates = isRpcActive
      ? (multiSessionActive ? [runtime.candidates[0], ...mainFallback] : runtime.candidates)
      : []
    const activities = await buildPresenceActivities({
      rpcConfigs: mainPushCandidates,
      customStatus: isStatusActive ? session.customStatus : null,
      customStatusEmoji: isStatusActive ? session.customStatusEmoji : null,
      placeholderCtx,
      vrStatusActive: (isStatusActive && (session.statusPlatform === 'meta_quest' || session.vrStatusActive)) || (isRpcActive && fullSelection.candidates[0]?.platform === 'meta_quest'),
      platform: isRpcActive ? (fullSelection.candidates[0]?.platform || 'desktop') : targetPlatform,
      // User OAuth token — required to resolve image URLs into animated-capable
      // mp:external asset references via Discord's external-assets endpoint.
      userAccessToken: session.discordAccessToken,
      // Per-slot app IDs + per-candidate game spoofing (inside the builder).
      rpcAppIdMap,
    })

    // Defense-in-depth: raw http(s) URLs inside assets are silently dropped by
    // Discord. Strip them so a failed asset resolution can never make the RPC
    // image disappear (the "image not showing" bug).
    const safeActivities = sanitizeActivities(activities as Array<Record<string, unknown>>)

    const status = isStatusActive ? (session.userStatus || 'online') : (isRpcActive ? 'online' : 'invisible')
    const activitiesHash = JSON.stringify({ status, activities: safeActivities })

    // MULTI-SESSION maintenance — extras carry their own hash guards, so this
    // is cheap every tick and recovers dead sessions even when the main push
    // is unchanged. Auto Rotate (game included) / single-candidate / RPC-off
    // → closes extras. Rotate with the game PINNED keeps its extra alive.
    this.maintainSlotSessions(userId, session.discordAccessToken ?? '', status, extras, multiSessionActive || rotateGameExtraActive)

    // Avoid spamming identical OP 3 payloads unless forced (prevents rate limits)
    if (!force && userSock.lastActivitiesHash === activitiesHash && userSock.lastStatus === status) {
      return
    }

    if (isRpcActive && runtime.runtimeMode === 'rotate' && runtime.rotateIndex != null) {
      const poolNote = Array.isArray(rotate.slots)
        ? `, selection: ${runtime.rotatePoolLength} of ${fullSelection.candidates.length} RPCs${rotateGameExtraActive ? `, ${rotateGameExtras.length} left-out RPC(s) stay visible` : ''}`
        : `${rotate.includeGame ? '' : ', excluded games pinned to their own sessions'}`
      console.log(`[10X RPC Daemon] Auto Rotate for user ${userId}: candidate ${runtime.rotateIndex + 1}/${runtime.rotatePoolLength ?? fullSelection.candidates.length} (${runtime.candidates[0]?.name ?? '?'}) every ${rotate.secs}s, order=${rotate.order}${rotate.skip > 0 ? `, skip+${rotate.skip}` : ''}${poolNote}`)
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
    // Extras are independent of the main socket — always tear them down here.
    this.closeAllSlotSessions(userId)
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
      const ws = userSock.ws
      // Same hygiene as closeSlotSession: never leave the socket listener-less
      // (a close during CONNECTING emits 'error' asynchronously) and never
      // call close() on a CONNECTING socket (throws in some ws versions).
      try { ws.removeAllListeners() } catch {}
      try { ws.on('error', () => {}) } catch {}
      try {
        if (ws.readyState === WebSocket.OPEN) ws.close()
        else ws.terminate()
      } catch {
        try { ws.terminate() } catch {}
      }
      userSock.ws = null
    }
    userSock.connected = false
    userSock.isConnecting = false
  }

  // ────────────────────────────────────────────────────────────────────────
  // MULTI-SESSION METHODS — one extra gateway session per additional RPC.
  // ────────────────────────────────────────────────────────────────────────

  private slotSessionMap(userId: string): Map<string, SlotSession> {
    let m = this.slotSessions.get(userId)
    if (!m) {
      m = new Map<string, SlotSession>()
      this.slotSessions.set(userId, m)
    }
    return m
  }

  /** Total live extra sessions (health endpoint). */
  private slotSessionLiveCount(): number {
    let n = 0
    for (const m of this.slotSessions.values()) {
      for (const s of m.values()) if (s.connected) n++
    }
    return n
  }

  private closeSlotSession(sess: SlotSession): void {
    sess.aborted = true
    if (sess.heartbeatTimer) {
      clearInterval(sess.heartbeatTimer)
      sess.heartbeatTimer = undefined
    }
    if (sess.ws) {
      const ws = sess.ws
      // Removing all listeners first leaves the socket without an 'error'
      // handler — a close() during CONNECTING aborts the handshake and emits
      // 'error' asynchronously → uncaughtException. Re-attach a no-op handler
      // after stripping listeners and use terminate() for non-OPEN states
      // (close() itself throws in the CONNECTING state in some ws versions).
      try { ws.removeAllListeners() } catch {}
      try { ws.on('error', () => {}) } catch {}
      try {
        if (ws.readyState === WebSocket.OPEN) ws.close()
        else ws.terminate()
      } catch {
        try { ws.terminate() } catch {}
      }
      sess.ws = null
    }
    sess.connected = false
    sess.isConnecting = false
  }

  /** Close every extra session of a user (rotate on, RPC off, platform or
   *  token changed, user disconnected). Next multi-session tick re-opens. */
  closeAllSlotSessions(userId: string): void {
    const m = this.slotSessions.get(userId)
    if (!m) return
    for (const sess of m.values()) this.closeSlotSession(sess)
    this.slotSessions.delete(userId)
    this.slotSessionsToken.delete(userId)
  }

  /** Open ONE extra session that pushes exactly `activity` (single activity
   *  per session — the Multi-Session model). The session entry is created
   *  synchronously; the WebSocket connect itself can be deferred (`delayMs`)
   *  to stagger identifies and avoid Discord OP 9 rate-limit bursts.
   *  Fire-and-forget; failures are recorded on the session and retried with
   *  backoff by maintainSlotSessions. */
  private openSlotSession(
    userId: string,
    key: string,
    label: string,
    token: string,
    platform: string,
    status: string,
    activity: Record<string, unknown>,
    configHash: string,
    delayMs: number = 0
  ): void {
    const map = this.slotSessionMap(userId)
    const prev = map.get(key)
    if (prev) this.closeSlotSession(prev)

    const sess: SlotSession = {
      key,
      ws: null,
      heartbeatAck: true,
      connected: false,
      isConnecting: true,
      identifiedPlatform: platform,
      lastActivityHash: configHash,
      lastActivity: activity,
      lastPushedStatus: status,
      failCount: prev?.failCount ?? 0,
      aborted: false,
    }
    map.set(key, sess)

    const connect = () => {
      if (sess.aborted || sess.ws || sess.connected) return
      try {
        const ws = new WebSocket(CONFIG.discord.gatewayUrl)
        sess.ws = ws
        let settled = false
        const connectTimeout = setTimeout(() => {
          if (!settled) {
            settled = true
            sess.failCount++
            sess.lastFailAt = Date.now()
            sess.isConnecting = false
            console.warn(`[10X RPC Daemon] Slot session connect timeout for user ${userId} (${label})`)
            try { ws.terminate() } catch {}
          }
        }, 15000)

      ws.on('message', (data: Buffer | string) => {
        try {
          const payload = JSON.parse(typeof data === 'string' ? data : data.toString())
          const op = payload.op
          const t = payload.t
          if (op === 10) {
            const interval = payload.d?.heartbeat_interval || 41250
            sess.heartbeatTimer = setInterval(() => {
              if (!sess.ws || sess.ws.readyState !== WebSocket.OPEN) {
                if (sess.heartbeatTimer) clearInterval(sess.heartbeatTimer)
                return
              }
              if (!sess.heartbeatAck && sess.lastHeartbeatSentAt && Date.now() - sess.lastHeartbeatSentAt > 20000) {
                // Zombie — drop it; the next maintenance tick re-opens.
                if (sess.heartbeatTimer) clearInterval(sess.heartbeatTimer)
                sess.failCount++
                sess.lastFailAt = Date.now()
                this.closeSlotSession(sess)
                return
              }
              sess.heartbeatAck = false
              sess.lastHeartbeatSentAt = Date.now()
              try { ws.send(JSON.stringify({ op: 1, d: null })) } catch {}
            }, interval)
            const { properties } = buildIdentify(platform)
            ws.send(JSON.stringify({ op: 2, d: { token: discordAuthValue(token), properties } }))
          } else if (op === 11) {
            sess.heartbeatAck = true
            sess.lastHeartbeatSentAt = undefined
          } else if (op === 1) {
            try { ws.send(JSON.stringify({ op: 1, d: null })) } catch {}
          } else if (op === 0 && t === 'READY') {
            if (!settled) {
              settled = true
              clearTimeout(connectTimeout)
            }
            sess.connected = true
            sess.isConnecting = false
            sess.failCount = 0
            try {
              ws.send(JSON.stringify({
                op: 3,
                d: { status, activities: [activity], afk: false, since: null },
              }))
              console.log(`[10X RPC Daemon] Multi-Session: extra session live for user ${userId} — "${label}" (platform=${platform}, class=${discordPlatformClass(platform)}, app=${String((activity as { application_id?: string }).application_id ?? '?')})`)
            } catch {}
          } else if (op === 0 && t === 'PRESENCE_UPDATE') {
            // Task 84d — these sessions receive PRESENCE_UPDATE events for
            // OTHER guild members too (verified: the old unfiltered log showed
            // empty [] noise from random users). Only the user's own echo
            // says anything about what Discord accepted for THIS slot.
            const echoUserId = (payload.d as { user?: { id?: string } } | undefined)?.user?.id
            if (echoUserId === userId) {
              // Echo — the authoritative "what Discord accepted" for THIS slot.
              try {
                const acts = payload.d?.activities
                if (Array.isArray(acts)) {
                  const sig = acts.map((a: { name?: string; type?: number }) => `${a.name ?? '?'}:${a.type ?? '?'}`).join('|')
                  console.log(`[10X RPC Daemon] Multi-Session echo for user ${userId} ("${label}"): [${sig}]`)
                }
              } catch {}
            }
          } else if (op === 9) {
            if (!settled) {
              settled = true
              clearTimeout(connectTimeout)
            }
            sess.failCount++
            sess.lastFailAt = Date.now()
            sess.isConnecting = false
            this.closeSlotSession(sess)
            console.warn(`[10X RPC Daemon] Slot session OP 9 for user ${userId} ("${label}") — backing off`)
          }
        } catch { /* ignore parse errors */ }
      })

      ws.on('error', () => {
        if (!settled) {
          settled = true
          clearTimeout(connectTimeout)
        }
        sess.failCount++
        sess.lastFailAt = Date.now()
        sess.isConnecting = false
        this.closeSlotSession(sess)
      })

      ws.on('close', (code, reason) => {
        if (!settled) {
          settled = true
          clearTimeout(connectTimeout)
        }
        // Task 84d — extras were dying SILENTLY (a slot's card vanished with
        // no trace in the console). Always log the close code/reason so any
        // Discord-side invalidation is immediately visible and diagnosable.
        if (sess.connected || code !== 1000) {
          console.warn(`[10X RPC Daemon] Slot session closed for user ${userId} ("${label}") — code=${code} reason=${reason?.toString?.() || 'none'} wasConnected=${sess.connected}`)
        }
        if (sess.connected) {
          sess.failCount++
          sess.lastFailAt = Date.now()
        }
        sess.connected = false
        sess.isConnecting = false
        if (sess.heartbeatTimer) {
          clearInterval(sess.heartbeatTimer)
          sess.heartbeatTimer = undefined
        }
      })
      } catch (err) {
        sess.failCount++
        sess.lastFailAt = Date.now()
        sess.isConnecting = false
        console.warn(`[10X RPC Daemon] Slot session open failed for user ${userId} ("${label}"):`, err)
      }
    }

    // Staggered connect: burst-identifying several extra sessions at once
    // trips Discord's per-token identify rate limit (OP 9) — space them out.
    if (delayMs > 0) setTimeout(connect, delayMs)
    else connect()
  }

  /**
   * Keep the user's extra per-RPC sessions in sync with the desired extras.
   * Runs every tick — per-session hash guards make it a no-op when nothing
   * changed. `active=false` (rotate / single candidate / RPC off) closes all.
   */
  private maintainSlotSessions(
    userId: string,
    token: string,
    status: string,
    extras: Array<{ key: string; label: string; platform: string; activity: Record<string, unknown>; configHash: string }>,
    active: boolean
  ): void {
    if (!active) {
      if (this.slotSessions.has(userId)) {
        this.closeAllSlotSessions(userId)
        console.log(`[10X RPC Daemon] Multi-Session off for user ${userId} — extra RPC sessions closed`)
      }
      return
    }

    // Token changed (refresh / re-login) → rebuild every extra with the new token.
    const fingerprint = token ? token.slice(-12) : ''
    if (this.slotSessionsToken.get(userId) !== fingerprint) {
      this.closeAllSlotSessions(userId)
      this.slotSessionsToken.set(userId, fingerprint)
    }

    const map = this.slotSessionMap(userId)
    const wanted = new Set(extras.map(e => e.key))
    for (const [key, sess] of map) {
      if (!wanted.has(key)) {
        this.closeSlotSession(sess)
        map.delete(key)
      }
    }

    const now = Date.now()
    // Identify-burst guard: every actual (re)connect this pass gets a base
    // offset + 3.5s × ordinal delay — live-verified spacing that never trips
    // Discord's OP 9 invalid-session burst limit (1.5s did, on the 3rd+).
    let openOrdinal = 0
    const stagger = () => 1000 + (openOrdinal++ * 3500)
    for (const e of extras) {
      const sess = map.get(e.key)
      // NOTE: the reopen guard compares the STABLE CONFIG hash — the resolved
      // activity re-resolves dynamic placeholders ({time}/{uptime}…) every
      // tick, so hashing it would churn sessions (identify storms → OP 9).
      if (!sess) {
        this.openSlotSession(userId, e.key, e.label, token, e.platform, status, e.activity, e.configHash, stagger())
        continue
      }
      // Config changed on a live session → re-open with the new activity.
      if (sess.connected && sess.lastActivityHash !== e.configHash) {
        this.openSlotSession(userId, e.key, e.label, token, e.platform, status, e.activity, e.configHash, stagger())
        continue
      }
      // Status changed (dnd/idle/online) → re-push status + same activity.
      if (sess.connected && sess.lastPushedStatus !== status && sess.ws && sess.ws.readyState === WebSocket.OPEN && sess.lastActivity) {
        try {
          sess.ws.send(JSON.stringify({
            op: 3,
            d: { status, activities: [sess.lastActivity], afk: false, since: null },
          }))
          sess.lastPushedStatus = status
        } catch {}
        continue
      }
      // Task 84c — BUCKET RE-ASSERT: Discord merges concurrent sessions per
      // platform class with LAST-WRITE-WINS, so any other push into this
      // session's class (another integration, a stale client) silently hides
      // this card until the payload changes. Re-assert the exact same OP 3
      // every tick — idempotent, cheap (no identify), and the daemon always
      // ends up the last writer within 10s.
      if (sess.connected && sess.ws && sess.ws.readyState === WebSocket.OPEN && sess.lastActivity) {
        try {
          sess.ws.send(JSON.stringify({
            op: 3,
            d: { status, activities: [sess.lastActivity], afk: false, since: null },
          }))
          sess.lastPushedStatus = status
        } catch {}
        continue
      }
      // Dead session → re-open after a short backoff (no reconnect storms).
      if (!sess.connected && !sess.isConnecting) {
        if (sess.lastFailAt && now - sess.lastFailAt < 45000) continue
        this.openSlotSession(userId, e.key, e.label, token, e.platform, status, e.activity, e.configHash, stagger())
      }
    }
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
      multiSessionConnections: this.slotSessionLiveCount(),
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
