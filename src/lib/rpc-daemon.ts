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
  buildGlobalDisplayTypeInputs,
  sortedSlotRows,
  discordPlatformClass,
  isValidActivityPlatform,
  resolveRpcMainCardLabel,
  type PresenceResult,
  type RpcCandidate,
  type DisplayTypeCandidate,
} from './rpc-manager'
import { resolvePlaceholders, type PlaceholderContext } from './placeholders'
import { sanitizeActivities } from './discord-assets'
import { discordAuthValue } from './discord-auth'
import { buildIdentify } from './gateway-platform'
import { normalizeRotateOrder, type RotateOrder } from './rotation'
import { decideGameRotation } from './game-rotation'
import { patchDiscordAccountSettings } from './discord-settings'
import {
  accountStatusPatchOwner,
  daemonRoleFromEnv,
  planRolePresencePlatforms,
  roleWantsGame,
  roleWantsRpc,
  roleWantsStatus,
  tokenRefreshWindowMinutes,
  GAME_EXTRA_PLATFORM_POOL,
  type DaemonRole,
} from './daemon-roles'
import { ensureRpcConfiguredColumn, visibleRpcRows } from './rpc-configured'
import { reconcileRpcRotationFlags, type RpcRotationSettingsLite } from './rpc-rotation-lifecycle'

// ─── Daemon role split (NODE 1 = STATUS / NODE 2 = RPC / NODE 3 = GAME RPC) ─
// DAEMON_ROLE unset / 'all' = the classic combined daemon — every role gate
// below short-circuits to the EXACT pre-split behavior (sandbox, local dev,
// and the deployment transition window). 'status' | 'rpc' | 'game' run the
// role-gated pillar. See daemon-roles.ts for the cross-daemon platform-class
// contract that keeps the three nodes' Discord sessions collision-free.
const DAEMON_ROLE: DaemonRole = daemonRoleFromEnv()

/** DEVICE-SELECTION RULE — the activity-level label the GAME role's main
 *  card owns while a Game RPC is live. Slot-card extras must never take it
 *  (two cards with the same label merge client-side, Task 91). */
const RESERVED_GAME_MAIN_LABEL: ReadonlySet<string> = new Set(['embedded'])

/** The daemon role this process runs ('all' = combined pre-split behavior). */
export function getDaemonRole(): DaemonRole {
  return DAEMON_ROLE
}

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
      // PostgreSQL carries the flavored INSERT/RETURNING below; SQLite
      // (sandbox/local) has no ::text casts / ON CONFLICT DO NOTHING in this
      // shape — the Prisma-client seeding path below covers it there.
      const url = (process.env.DATABASE_URL || '').trim()
      if (url.startsWith('file:')) {
        // SQLite seeding path (identical semantics, engine-native API).
        const user = await db.user.findUnique({
          where: { id: userId },
          include: { trial: true },
        }).catch(() => null)
        const trialEnds = user?.trial?.endsAt && user.trial.endsAt > new Date()
          ? user.trial.endsAt
          : new Date(Date.now() + 3 * 86_400_000)
        await db.subscription.create({ data: { userId, plan: 'free', status: 'trialing', trialEndsAt: trialEnds } }).catch(() => null)
        rows = await db.$queryRaw<DaemonSubRow[]>`
          SELECT plan, status, "trialEndsAt", "currentPeriodEnd"
          FROM "Subscription" WHERE "userId" = ${userId} LIMIT 1`
      } else {
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

// ─── Task 95 — GAME Auto-Rotate (raw SQL — Orihost-safe) ────────────────────
// The GAME rotation system is FULLY INDEPENDENT from the Normal RPC rotation
// above: separate columns (gameRotate*), separate clock anchor, separate skip
// counter, separate pool. The Normal rotation NEVER reads gameRotate* state
// and this reconcile NEVER reads rpcAutoRotate* state. Each tick decides —
// via the pure game-rotation lib — which ONE game is active, then persists
// rotation state + enabled flags. GameConfig.enabled is the ONLY game field
// this ever writes; saved game configs are 100% read-only to rotation.

interface GameRotateSettingsRaw {
  enabled: boolean
  secs: number
  order: RotateOrder
  skip: number
  appliedSkip: number
  slots: string[] | null
  current: string | null
  anchorMs: number | null
}

const GAME_ROTATE_OFF: GameRotateSettingsRaw = {
  enabled: false,
  secs: 60,
  order: 'forward',
  skip: 0,
  appliedSkip: 0,
  slots: null,
  current: null,
  anchorMs: null,
}

async function fetchGameRotateSettings(userId: string): Promise<GameRotateSettingsRaw> {
  try {
    const rows = await db.$queryRaw<Array<{
      gameRotateEnabled: boolean | number
      gameRotateSecs: number | null
      gameRotateOrder: string | null
      gameRotateSkip: number | null
      gameRotateAppliedSkip: number | null
      gameRotateSlots: string | null
      gameRotateCurrent: string | null
      gameRotateAnchorAt: Date | string | null
    }>>`
      SELECT "gameRotateEnabled", "gameRotateSecs", "gameRotateOrder", "gameRotateSkip",
             "gameRotateAppliedSkip", "gameRotateSlots", "gameRotateCurrent", "gameRotateAnchorAt"
      FROM "GlobalConfig" WHERE "userId" = ${userId} LIMIT 1`
    const r = rows?.[0]
    if (!r) return GAME_ROTATE_OFF
    const en = r.gameRotateEnabled
    return {
      enabled: en === true || (en as unknown) === 1,
      secs: Math.max(15, Math.min(3600, Number(r.gameRotateSecs ?? 60) || 60)),
      order: normalizeRotateOrder(r.gameRotateOrder),
      skip: Math.max(0, Math.min(1_000_000_000, Math.floor(Number(r.gameRotateSkip) || 0))),
      appliedSkip: Math.max(0, Math.min(1_000_000_000, Math.floor(Number(r.gameRotateAppliedSkip) || 0))),
      slots: parseRotateSlots(r.gameRotateSlots),
      current: typeof r.gameRotateCurrent === 'string' && r.gameRotateCurrent ? r.gameRotateCurrent : null,
      anchorMs: r.gameRotateAnchorAt ? new Date(r.gameRotateAnchorAt).getTime() : null,
    }
  } catch (e) {
    // Missing columns (pre-Task-95 DB) or no row → rotation OFF. Never fatal.
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`[10X RPC Daemon] game rotate settings read failed for ${userId} (rotation OFF):`, e instanceof Error ? e.message : e)
    }
    return GAME_ROTATE_OFF
  }
}

/** Persist rotation STATE via raw SQL — updatedAt (the NORMAL rotation's
 *  clock anchor) must never move. Creates the row if missing. Returns false
 *  when the write failed (columns not migrated yet) — rotation skips a tick. */
async function persistGameRotationStateRaw(
  userId: string,
  state: { current: string | null; anchorMs: number | null; appliedSkip: number },
): Promise<boolean> {
  try {
    const n = await db.$executeRaw`
      UPDATE "GlobalConfig"
      SET "gameRotateCurrent" = ${state.current},
          "gameRotateAnchorAt" = ${state.anchorMs !== null && Number.isFinite(state.anchorMs) ? new Date(state.anchorMs) : null},
          "gameRotateAppliedSkip" = ${state.appliedSkip}
      WHERE "userId" = ${userId}`
    if (n === 0) {
      await db.globalConfig.create({ data: { userId } })
      await db.$executeRaw`
        UPDATE "GlobalConfig"
        SET "gameRotateCurrent" = ${state.current},
            "gameRotateAnchorAt" = ${state.anchorMs !== null && Number.isFinite(state.anchorMs) ? new Date(state.anchorMs) : null},
            "gameRotateAppliedSkip" = ${state.appliedSkip}
        WHERE "userId" = ${userId}`
    }
    return true
  } catch (e) {
    console.warn(`[10X RPC Daemon] game rotation state persist failed for ${userId}:`, e instanceof Error ? e.message : e)
    return false
  }
}

/** Flip GameConfig.enabled so EXACTLY keepSlug is enabled (single-active). */
async function applySingleActiveGame(userId: string, keepSlug: string | null): Promise<boolean> {
  const off = await db.gameConfig.updateMany({
    where: keepSlug
      ? { userId, enabled: true, gameSlug: { not: keepSlug } }
      : { userId, enabled: true },
    data: { enabled: false },
  })
  if (keepSlug) {
    await db.gameConfig.updateMany({ where: { userId, gameSlug: keepSlug }, data: { enabled: true } })
  }
  return off.count > 0
}

/**
 * Per-user GAME rotation reconcile (Task 95). Runs BEFORE the presence
 * selection in every syncAllUsers pass so the SAME tick publishes the
 * reconciled state. Decides (pure lib) → persists (raw SQL, updatedAt
 * untouched) → mutates the in-memory rows so this tick's candidate list
 * already matches the DB (no refetch).
 */
async function reconcileGameRotationForUser(
  userId: string,
  gameRows: Array<{ gameSlug: string; enabled: boolean; createdAt: Date | string }>,
): Promise<void> {
  const settings = await fetchGameRotateSettings(userId)
  const allGames = gameRows.map(g => ({
    gameSlug: g.gameSlug,
    enabled: g.enabled,
    createdAtMs: new Date(g.createdAt).getTime(),
  }))
  const decision = decideGameRotation(settings, allGames, Date.now())
  if (decision.stateDirty) {
    await persistGameRotationStateRaw(userId, {
      current: decision.current,
      anchorMs: decision.anchorMs,
      appliedSkip: decision.appliedSkip,
    })
  }
  if (decision.flagsDirty) {
    await applySingleActiveGame(userId, decision.desiredCurrent)
  }
  // Mutate the in-memory rows so the rest of this tick sees the reconciled
  // enabled set.
  for (const g of gameRows) {
    const want = decision.desiredCurrent !== null && g.gameSlug === decision.desiredCurrent
    if (g.enabled !== want) g.enabled = want
  }
}

/**
 * Task 113 — per-user NORMAL RPC Auto-Rotate LIFECYCLE reconcile. Runs right
 * after the game reconcile in every syncAllUsers pass so the SAME tick
 * publishes the reconciled state.
 *
 * While Auto Rotate is ON (and the master RPC gate is on), the rotator OWNS
 * the pool members' enabled flags: exactly the member whose turn it is — the
 * SAME member resolveRuntimeCandidates publishes on Discord (shared
 * rotation.ts clock) — carries enabled=true; every other POOL member is
 * OFF. This is what makes the dashboard switches, the database and Discord
 * describe the same live RPC at every moment:
 *   • a slot that was enabled before Auto Rotate started is managed by the
 *     rotation from the first tick on (requirement 6 — no independent runs),
 *   • every interval boundary disables the previous member and activates the
 *     next one (requirements 4/5),
 *   • unconfigured rows are never pool members and never touched,
 *   • rotation OFF / master OFF → ZERO writes (requirement 10; switches keep
 *     exactly the state the user left them in).
 * Non-pool enabled slots (explicitly left out of the selection) keep running;
 * the rotator never enables a member alongside one of them (one-active-slot
 * invariant, Task 108).
 *
 * Role-gated to the rpc pillar (roleWantsRpc) so the three daemon nodes never
 * race the same flag writes — mirrors the game reconcile's role gate.
 * Mutates the in-memory rows to the authoritative post-apply enabled set so
 * the rest of this tick sees the reconciled flags (no refetch).
 */
async function reconcileRpcRotationForUser(
  userId: string,
  slotRows: Array<{ id?: string | null; enabled: boolean; createdAt?: Date | string | null }>,
  masterOn: boolean,
): Promise<{ nextSwitchInSecs: number | null } | null> {
  const configured = slotRows.filter(r => typeof r.id === 'string' && r.id.length > 0)
  if (configured.length === 0) return null

  const rotate = await fetchRpcRotateSettings(userId)
  if (!rotate.enabled || !masterOn) return null

  const settings: RpcRotationSettingsLite = {
    enabled: true,
    secs: rotate.secs,
    order: rotate.order,
    skip: rotate.skip,
    refMs: rotate.refMs,
    slots: rotate.slots,
    seed: userId,
  }
  const nowMs = Date.now()
  const liteRows: Array<{ id: string; enabled: boolean; createdAtMs: number }> = configured.map(r => ({
    id: r.id as string,
    enabled: !!r.enabled,
    createdAtMs: r.createdAt ? new Date(r.createdAt).getTime() : 0,
  }))
  const result = await reconcileRpcRotationFlags(userId, settings, liteRows, nowMs, true)

  // Mirror the authoritative enabled set in memory (no re-read).
  const enabledSet = new Set(result.enabledIds)
  for (const r of configured) {
    const want = enabledSet.has(r.id as string)
    if (r.enabled !== want) r.enabled = want
  }
  if (result.changed) {
    console.log(`[10X RPC Daemon] Auto-Rotate lifecycle for ${userId}: RPC ${result.currentId} is now live (${result.poolIds.length}-RPC pool, next switch in ${result.nextSwitchInSecs ?? '?'}s)`)
  }
  return { nextSwitchInSecs: result.nextSwitchInSecs }
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
  /** The ACCOUNT-level status this user's Discord settings were last patched
   *  with (Task 97). Discord IGNORES the OP 3 `status` field for OAuth/sdk
   *  sessions — the profile status is pinned to user_settings.status, so the
   *  daemon PATCHes /users/@me/settings whenever the desired status differs
   *  from the last applied one (self-heal: user picks, toggles, restarts). */
  lastAccountStatus?: string
  /** The Discord token whose IDENTIFY was rejected with 4004 (Authentication
   *  failed). 4004 means the token ITSELF is dead (revoked/reset) — retrying
   *  the same token hits 4004 forever. Auth stays fatal until the stored
   *  token CHANGES (re-login / new token), which auto-unblocks the user. */
  failedAuthToken?: string | null
  // ── Task 99 — APPLY-VERIFY-RETRY ("instant & reliable status updates") ──
  /** Fingerprint of the saved config this socket last SUCCESSFULLY applied
   *  (OP 3 send completed without throwing, or the post-READY forced push
   *  after a platform re-identify completed). Compared against the desired
   *  fingerprint on every sync AND every tick; mismatch = the running state
   *  does NOT match the saved configuration → re-apply until it does. */
  lastAppliedFingerprint?: string
  /** The desired fingerprint computed from the latest DB read (set before
   *  the apply attempt so a successful send can stamp it atomically). */
  desiredFingerprint?: string
  /** Pending apply-retry timer (the intelligent backoff chain armed when an
   *  apply could not be confirmed). Single-flight per user. */
  applyRetryTimer?: NodeJS.Timeout
  applyRetryCount?: number
}

/**
 * Task 99 — SAVED-CONFIG FINGERPRINT for one user, scoped to THIS daemon's
 * role. A pure function of the DB rows — identical on all nodes; each node
 * compares it against ITS socket's lastAppliedFingerprint to answer the only
 * question that matters for reliability: "does the running presence match
 * the saved configuration?".
 *
 * Field choice per role (drift on a foreign role's fields must NEVER make
 * this node re-push — its pushes cannot express that change):
 *   status role → the Session status fields (userStatus, custom msg+emoji,
 *                 statusPlatform, vrStatusActive, statusEnabled, rotator)
 *   rpc role    → rpcEnabled + every RpcConfig row's identity/enabled/updatedAt
 *   game role   → rpcEnabled + every enabled GameConfig row's identity/updatedAt
 *   all         → everything (combined pre-split daemon)
 *
 * updatedAt is INCLUDED: a save bumps it even when values are identical, and
 * the user's requirement is "every configuration change must trigger an
 * immediate update". The resulting extra verify pass is harmless — the
 * activities hash guard turns a no-op save into zero OP 3 traffic.
 */
function presenceConfigFingerprint(
  session: {
    statusEnabled?: boolean | null
    rpcEnabled?: boolean | null
    userStatus?: string | null
    customStatus?: string | null
    customStatusEmoji?: string | null
    statusPlatform?: string | null
    vrStatusActive?: boolean | null
    sleepTimerActive?: boolean | null
  },
  rpcConfigs: Array<{ id?: string | null; enabled?: boolean | null; updatedAt?: Date | string | null }>,
  enabledGames: Array<{ gameSlug?: string | null; updatedAt?: Date | string | null }>,
  rotatorEnabled?: boolean | null,
  /** Task 107 — the user's GlobalConfig row. The rpc/all fingerprints now
   *  include the AUTO ROTATE settings (on/secs/order/skip/slots/includeGame):
   *  a rotation-only change (enable, selection, interval, order, skip) used
   *  to leave the fingerprint UNCHANGED, so syncUser took the cheap no-op
   *  branch and the new rotation state waited for the next tick instead of
   *  applying instantly. Defensive reads keep this safe on standalone Orihost
   *  Prisma clients generated before the rpcRotate* columns existed (undefined
   *  → stable constant → no phantom drift). */
  globalConfigRow?: unknown
): string {
  const ts = (d?: Date | string | null) => (d ? new Date(d).getTime() : 0)
  const rotFp = (): Record<string, unknown> => {
    const gc = globalConfigRow as
      | { rpcAutoRotate?: unknown; rpcRotateSecs?: unknown; rpcRotateOrder?: unknown; rpcRotateSkip?: unknown; rpcRotateSlots?: unknown; rpcRotateIncludeGame?: unknown }
      | null
      | undefined
    if (!gc || typeof gc !== 'object') return { on: 0 }
    const on = gc.rpcAutoRotate === true || gc.rpcAutoRotate === 1
    if (!on) return { on: 0 }
    return {
      on: 1,
      secs: Number(gc.rpcRotateSecs) || 0,
      order: typeof gc.rpcRotateOrder === 'string' ? gc.rpcRotateOrder : '',
      skip: Math.max(0, Math.floor(Number(gc.rpcRotateSkip) || 0)),
      slots: typeof gc.rpcRotateSlots === 'string' ? gc.rpcRotateSlots : '',
      ig: gc.rpcRotateIncludeGame === false || gc.rpcRotateIncludeGame === 0 ? 0 : 1,
    }
  }
  if (DAEMON_ROLE === 'status') {
    return JSON.stringify({
      r: 'status',
      se: session.statusEnabled ? 1 : 0,
      st: session.userStatus || 'online',
      cs: session.customStatus ?? null,
      ce: session.customStatusEmoji ?? null,
      sp: session.statusPlatform || 'mobile',
      vr: session.vrStatusActive ? 1 : 0,
      rot: rotatorEnabled ? 1 : 0,
      sleep: session.sleepTimerActive ? 1 : 0,
    })
  }
  if (DAEMON_ROLE === 'rpc') {
    return JSON.stringify({
      r: 'rpc',
      re: session.rpcEnabled ? 1 : 0,
      slots: rpcConfigs.map(c => `${c.id ?? ''}:${c.enabled ? 1 : 0}:${ts(c.updatedAt)}`),
      rot: rotFp(),
    })
  }
  if (DAEMON_ROLE === 'game') {
    return JSON.stringify({
      r: 'game',
      re: session.rpcEnabled ? 1 : 0,
      games: enabledGames.map(g => `${g.gameSlug ?? ''}:${ts(g.updatedAt)}`),
    })
  }
  return JSON.stringify({
    r: 'all',
    se: session.statusEnabled ? 1 : 0,
    st: session.userStatus || 'online',
    cs: session.customStatus ?? null,
    ce: session.customStatusEmoji ?? null,
    sp: session.statusPlatform || 'mobile',
    vr: session.vrStatusActive ? 1 : 0,
    re: session.rpcEnabled ? 1 : 0,
    slots: rpcConfigs.map(c => `${c.id ?? ''}:${c.enabled ? 1 : 0}:${ts(c.updatedAt)}`),
    games: enabledGames.map(g => `${g.gameSlug ?? ''}:${ts(g.updatedAt)}`),
    rot: rotatorEnabled ? 1 : 0,
    rpcRot: rotFp(),
    sleep: session.sleepTimerActive ? 1 : 0,
  })
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
  /** Task 113 — one-shot timer armed on the NEXT Auto-Rotate boundary when it
   *  lands sooner than the regular 10s tick (instant switch + flag flips). */
  private rotatePrecisionTimer?: NodeJS.Timeout
  /** Earliest upcoming Auto-Rotate boundary (ms epoch) seen in the last pass. */
  private nextRotateBoundaryAt: number | null = null
  /** Re-entrancy guard — a tick (regular, watchdog or precision) never runs
   *  concurrently with another one. */
  private tickInProgress = false
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
    if (this.rotatePrecisionTimer) {
      clearTimeout(this.rotatePrecisionTimer)
      this.rotatePrecisionTimer = undefined
    }
    this.nextRotateBoundaryAt = null

    for (const [userId, userSock] of this.sockets.entries()) {
      this.cleanupSocket(userSock)
    }
    this.sockets.clear()
    console.log('[10X RPC Daemon] Daemon stopped.')
  }

  /**
   * Task 113 — PRECISION ROTATION TICK. After a pass, when the earliest
   * upcoming Auto-Rotate boundary lands sooner than the next regular 10s
   * tick, arm a one-shot tick EXACTLY on that boundary (+250ms cushion): the
   * flag flips and the presence switch land within ~a second of the clock
   * instead of up to a full tick late ("instant & accurate status updates").
   */
  private armRotationPrecisionTick(): void {
    if (this.rotatePrecisionTimer) {
      clearTimeout(this.rotatePrecisionTimer)
      this.rotatePrecisionTimer = undefined
    }
    const at = this.nextRotateBoundaryAt
    this.nextRotateBoundaryAt = null
    if (!at || !this.isRunning) return
    const deltaMs = at - Date.now()
    // Beyond the regular tick cadence → the 10s loop covers it; too close /
    // in the past → run one now-ish (still bounded).
    if (deltaMs >= 10500) return
    const waitMs = Math.max(300, deltaMs + 250)
    this.rotatePrecisionTimer = setTimeout(() => {
      this.rotatePrecisionTimer = undefined
      void this.tick().catch(() => {})
    }, waitMs)
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
    // Re-entrancy guard — the regular interval, the watchdog recovery and the
    // Task-113 precision tick all funnel here; overlapping passes would race
    // the same sockets and rotation flag writes.
    if (this.tickInProgress) return
    this.tickInProgress = true
    try {
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

        // Check token expiration (refresh if < 30 mins left). Role daemons
        // use STAGGERED windows (tokenRefreshWindowMinutes) so the three
        // nodes never race Discord's rotating refresh grants — after one
        // refresh the expiry jumps ~7 days out and the tighter windows of
        // the other roles never fire.
        if (session.discordTokenExpiresAt && session.discordTokenExpiresAt.getTime() - now.getTime() < tokenRefreshWindowMinutes(DAEMON_ROLE) * 60 * 1000) {
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

        // Check status rotator — a STATUS-pillar concern (it drives the
        // custom status text). Role daemons other than status/all skip it.
        if ((DAEMON_ROLE === 'all' || DAEMON_ROLE === 'status') && session.user.globalConfig?.rotatorEnabled) {
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

      // 3. Task 113 — arm the precision rotation tick when the earliest
      // upcoming Auto-Rotate boundary is sooner than the regular 10s loop.
      this.armRotationPrecisionTick()
    } finally {
      this.tickInProgress = false
    }
  }

  /** Initial socket platform for a NEW socket record, per daemon role. The
   *  authoritative value is recomputed in connectUserSocket — this only
   *  seeds the record so /status shows a sane platform immediately. */
  private roleSeedPlatform(
    session: { statusPlatform?: string | null; vrStatusActive?: boolean | null },
    selection: { candidates: Array<{ platform?: string | null; gameSlug?: string | null }> }
  ): string {
    if (DAEMON_ROLE === 'status') {
      return session.vrStatusActive || session.statusPlatform === 'meta_quest'
        ? 'meta_quest'
        : (session.statusPlatform || 'mobile')
    }
    if (DAEMON_ROLE === 'rpc') {
      // DEVICE-SELECTION RULE — mirror planRolePresencePlatforms: the main
      // session IDENTIFIES with the first slot's EXPLICIT device (the badge
      // the user picked) or the icon-less 'embedded' class for None/legacy
      // slots. The old unconditional 'ps4' anchor stamped PlayStation badges
      // onto cards whose user never selected a device — gone.
      const first = selection.candidates.find(c => !c.gameSlug)?.platform
      return first
        ? (first === 'meta_quest' || first === 'ps4' || first === 'ps5' || first === 'xbox' ? first : 'embedded')
        : 'desktop'
    }
    if (DAEMON_ROLE === 'game') return 'embedded'
    return selection.candidates[0]?.platform || 'desktop'
  }

  /**
   * Synchronize all active users from Postgres DB.
   * Only keeps connections alive for users with active RPC, custom status, or status rotator.
   * Cleans up and disconnects any user whose RPC and status are disabled.
   */
  public async syncAllUsers(): Promise<void> {
    const now = new Date()
    // Task 113 — a fresh pass recomputes the earliest Auto-Rotate boundary
    // from the live settings; drop the previous pass's value first.
    this.nextRotateBoundaryAt = null
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

      // Task 95 — GAME Auto-Rotate reconcile (FULLY independent from the
      // Normal RPC Auto-Rotate below): decide the single active game, persist
      // rotation state + enabled flags, then let THIS tick publish them.
      const allGameRows = session.user.gameConfigs ?? []
      // Game Auto-Rotate reconcile is GAME-pillar state — only the game role
      // (or the combined 'all' daemon) advances it, so the three nodes never
      // write racing enabled-flag flips.
      if (allGameRows.length > 0 && roleWantsGame(DAEMON_ROLE)) {
        try {
          await reconcileGameRotationForUser(session.userId, allGameRows)
        } catch (grErr) {
          console.warn(`[10X RPC Daemon] game rotation reconcile failed for ${session.userId} (skipped this tick):`, grErr instanceof Error ? grErr.message : grErr)
        }
      }

      // Task 113 — NORMAL RPC Auto-Rotate LIFECYCLE reconcile (RPC-pillar
      // state — only the rpc role or the combined 'all' daemon advances it).
      // Flips the pool members' enabled flags to the rotation clock's current
      // member (same inputs the presence resolver uses), so the DB, the
      // dashboard switches and Discord always describe the same live RPC.
      // Runs BEFORE rpcConfigs is read: it mutates those rows in place.
      let rotateNextBoundarySecs: number | null = null
      const configuredRpcRows = visibleRpcRows(session.user.rpcConfigs ?? [])
      if (configuredRpcRows.length > 0 && roleWantsRpc(DAEMON_ROLE)) {
        try {
          const rr = await reconcileRpcRotationForUser(
            session.userId,
            configuredRpcRows as Array<{ id?: string | null; enabled: boolean; createdAt?: Date | string | null }>,
            !!session.rpcEnabled,
          )
          if (rr?.nextSwitchInSecs != null) {
            rotateNextBoundarySecs = rr.nextSwitchInSecs
          }
        } catch (rrErr) {
          console.warn(`[10X RPC Daemon] rpc rotation reconcile failed for ${session.userId} (skipped this tick):`, rrErr instanceof Error ? rrErr.message : rrErr)
        }
      }
      if (rotateNextBoundarySecs != null) {
        // Track the EARLIEST upcoming switch across this pass's users — the
        // tick loop arms a precision tick on it (instant flag flips + pushes
        // at the boundary instead of up to a full 10s tick late).
        const prev = this.nextRotateBoundaryAt
        const at = Date.now() + rotateNextBoundarySecs * 1000
        this.nextRotateBoundaryAt = prev != null ? Math.min(prev, at) : at
      }

      const rpcConfigs = (session.user.rpcConfigs ?? []) as Array<RpcCandidate & { enabled: boolean }>
      // Task 89/95 — SINGLE-ACTIVE GAME: exactly ONE enabled game is a
      // candidate (the game-rotation reconcile above enforces this — manual
      // enables collapse it, Game Auto-Rotate cycles it). Task 92 —
      // deterministic createdAt order (the relation include has no orderBy;
      // the display-type orchestration requires BOTH daemons to see the SAME
      // candidate order).
      const enabledGames = allGameRows
        .filter(g => g.enabled)
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      // MULTI-RPC: every enabled slot (each with its own flag) + every enabled
      // game are candidates. No mode exclusivity — combinations are supported.
      const selection = selectActiveRpcConfigs(session.rpcEnabled, rpcConfigs, enabledGames)
      const hasRpc = selection.active
      const hasStatus = !!session.statusEnabled
      const hasRotator = !!(session.statusEnabled && session.user.globalConfig?.rotatorEnabled && session.user.rotatorPresets?.some(p => p.enabled))

      // Task 106/113 — ROTATION-ELIGIBLE SLOTS keep the daemon tracking the
      // user even when NO slot switch is ON: Auto Rotate ON + master RPC on +
      // at least one rotation member means the rotator still has an RPC to
      // publish AND manage. With an explicit selection the members are the
      // selected slots; with NO stored selection EVERY configured slot
      // rotates (requirement 1/2 — rotation works from the all-off state).
      // Reads ONLY the already loaded rows (no extra query); the same rule
      // the resolver and the flag reconcile apply.
      const gcRow = session.user.globalConfig as { rpcAutoRotate?: boolean | null; rpcRotateSlots?: string | null } | null
      const tickRotateKeys = parseRotateSlots(gcRow?.rpcRotateSlots)
      const rotationSelectedSlots = !!session.rpcEnabled
        && !!gcRow?.rpcAutoRotate
        && (tickRotateKeys && tickRotateKeys.length > 0
          ? rpcConfigs.some(r => r.id && tickRotateKeys.includes(r.id))
          : configuredRpcRows.length > 0)

      // ── Role-pillar activity for THIS daemon (daemon-roles.ts) ──────────
      // A role daemon only tracks the user while ITS pillar is active; the
      // combined 'all' daemon keeps the pre-split combined rule.
      const roleSlotsActive = (hasRpc && selection.candidates.some(c => !c.gameSlug)) || rotationSelectedSlots
      const roleGamesActive = hasRpc && selection.candidates.some(c => !!c.gameSlug)
      const roleActive = DAEMON_ROLE === 'status'
        ? (hasStatus || hasRotator)
        : DAEMON_ROLE === 'rpc'
          ? roleSlotsActive
          : DAEMON_ROLE === 'game'
            ? roleGamesActive
            : (hasRpc || hasStatus || hasRotator || rotationSelectedSlots)

      // Only track if THIS daemon's pillar is active for the user
      if (!roleActive) {
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
          platform: this.roleSeedPlatform(session, selection),
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
        // Task 99 — TICK DRIFT-CHECK (the infinite safety net): compare the
        // saved-config fingerprint against what this socket last applied.
        // Any drift (a lost /sync, a push that died on a transient Neon
        // outage, a change made mid-reconnect) is force-re-applied here via
        // syncUser — which also arms its own verify-retry chain. Identical
        // state stays on the cheap hash-guarded push (zero OP 3 traffic).
        const driftFp = presenceConfigFingerprint(
          session,
          rpcConfigs,
          allGameRows.filter(g => g.enabled),
          session.user.globalConfig?.rotatorEnabled,
          // Task 107 — rotation-only changes must drift-check as a change.
          session.user.globalConfig,
        )
        userSock.desiredFingerprint = driftFp
        if (userSock.lastAppliedFingerprint !== driftFp) {
          void this.syncUser(session.userId).catch(() => {})
        } else {
          void this.pushPresenceForUser(session.userId, session, false).catch(() => {})
        }
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
    // MULTI-SESSION LEAK FIX (the "every enabled RPC must show / nothing may
    // linger" contract): the role-inactive path used to clear + close ONLY
    // the MAIN socket here — the per-slot EXTRA sessions (and the game
    // role's pinned extras) stayed connected with their heartbeats and kept
    // pushing their cards FOREVER, because an untracked user is no longer
    // tick-maintained. Rapid disable/enable testing then also stacked
    // zombie sessions against Discord's concurrent-session budget until new
    // extras failed to identify — cards "missing" or replacing each other.
    // Clear every extra's card instantly, then close (same contract as
    // disconnectUser; the clear-first close also survives the Discord-side
    // teardown grace window).
    this.closeAllSlotSessions(userId)
    const session = await db.session.findFirst({
      where: { userId, expiresAt: { gt: new Date() }, discordAccessToken: { not: null } },
      orderBy: { createdAt: 'desc' },
    }).catch(() => null)
    if (!session || !session.discordAccessToken) return

    const userSock = this.sockets.get(userId)
    const hasStatus = !!session.statusEnabled
    const hasCustomStatus = !!(session.customStatus || session.customStatusEmoji)
    // Role view — only a status/all daemon holds the custom-status socket.
    // A role daemon for rpc/game simply clears its own session's presence
    // and closes (its pillar is being stopped).
    const statusSocketRole = roleWantsStatus(DAEMON_ROLE)

    if (userSock && userSock.ws && userSock.ws.readyState === WebSocket.OPEN && userSock.connected) {
      const activities: Array<Record<string, unknown>> = []
      if (statusSocketRole && hasStatus && hasCustomStatus) {
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

      // If status is not active (or this daemon owns no status pillar),
      // close socket cleanly and stop all timers
      if (!hasStatus || !statusSocketRole) {
        this.cleanupSocket(userSock)
        this.sockets.delete(userId)
      }
    } else if (statusSocketRole && hasStatus) {
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

    // Task 111 — the column must exist before any generated-client read.
    await ensureRpcConfiguredColumn().catch(() => false)

    const rpcConfigs = visibleRpcRows((await db.rpcConfig.findMany({
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
    })) as Array<RpcCandidate & { enabled: boolean }>)
    // Task 111 — rows the user never configured (legacy auto-created default
    // placeholders) are invisible to the runtime too: they can never be
    // published, rotate or anchor a session.
    // Task 89 — MULTI-GAME: every enabled game runs as its own candidate.
    const enabledGames = await db.gameConfig.findMany({ where: { userId, enabled: true }, orderBy: { createdAt: 'asc' } })
    // MULTI-RPC: all enabled slots + ALL enabled games (no mode exclusivity).
    const selection = selectActiveRpcConfigs(session.rpcEnabled, rpcConfigs, enabledGames)
    const hasRpc = selection.active
    const hasStatus = !!session.statusEnabled
    const hasRotator = !!(session.statusEnabled && session.user.globalConfig?.rotatorEnabled && session.user.rotatorPresets?.some(p => p.enabled))

    // Task 106 — ROTATION-SELECTED SLOTS keep this instant-sync path alive
    // even when NO slot is enabled (same rule as the tick gate below): Auto
    // Rotate ON + an explicit selection matching at least one created slot
    // means the pool still has members — this sync must REBUILD, never stop.
    const gcRowSync = session.user.globalConfig as { rpcAutoRotate?: boolean | null; rpcRotateSlots?: string | null } | null
    const syncRotateKeys = parseRotateSlots(gcRowSync?.rpcRotateSlots)
    const rotationSelectedSlots = !!session.rpcEnabled
      && !!gcRowSync?.rpcAutoRotate
      && !!syncRotateKeys
      && syncRotateKeys.length > 0
      && rpcConfigs.some(r => r.id && syncRotateKeys.includes(r.id))

    // Role-pillar activity (daemon-roles.ts) — a role daemon only owns its
    // own pillar's socket/pushes; the combined 'all' daemon keeps the
    // combined rule.
    const roleSlotsActive = (hasRpc && selection.candidates.some(c => !c.gameSlug)) || rotationSelectedSlots
    const roleGamesActive = hasRpc && selection.candidates.some(c => !!c.gameSlug)
    const roleActive = DAEMON_ROLE === 'status'
      ? (hasStatus || hasRotator)
      : DAEMON_ROLE === 'rpc'
        ? roleSlotsActive
        : DAEMON_ROLE === 'game'
          ? roleGamesActive
          : (hasRpc || hasStatus || hasRotator || rotationSelectedSlots)

    // If THIS daemon's pillar is not active for the user: stop & clear
    if (!roleActive) {
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
        platform: this.roleSeedPlatform(session, selection),
        lastStatus: session.userStatus || 'online',
        lastActivitiesHash: '',
        connected: false,
        isConnecting: false,
      }
      this.sockets.set(userId, userSock)
    }

    // ── Task 99 — desired fingerprint + EARLY platform-class restart ──────
    // Compute the saved-config fingerprint BEFORE any heavy work: if it was
    // already applied and nothing changed, this sync is a cheap no-op.
    const desiredFp = presenceConfigFingerprint(
      session,
      rpcConfigs,
      enabledGames,
      session.user.globalConfig?.rotatorEnabled,
      // Task 107 — rotation settings are part of the rpc fingerprint now.
      session.user.globalConfig,
    )
    userSock.desiredFingerprint = desiredFp

    // EARLY PLATFORM RESTART (the "OFF→ON the changed status automatically"
    // requirement): Discord derives the Mobile/VR/Desktop badge from the
    // IDENTIFY properties — an OP 3 can NOT change it, so a platform change
    // while the status is already running needs a FRESH gateway session.
    // Detect it HERE, before pushPresenceForUser's DB reads: a transient
    // Neon flake mid-path must never swallow the restart (the user's exact
    // reported bug). This is exactly the manual OFF→ON the user used to do,
    // now automatic and verified.
    const knownPlatform = userSock.identifiedPlatform ?? (userSock.connected ? userSock.platform : undefined)
    const earlyTarget = DAEMON_ROLE === 'status'
      ? planRolePresencePlatforms({
          statusEnabled: hasStatus,
          statusPlatform: session.statusPlatform,
          vrActive: !!session.vrStatusActive,
          firstSlotPlatform: selection.candidates.find(c => !c.gameSlug)?.platform || null,
          rpcEnabled: session.rpcEnabled,
        }).statusSessionPlatform
      : DAEMON_ROLE === 'rpc'
        ? planRolePresencePlatforms({
            statusEnabled: hasStatus,
            statusPlatform: session.statusPlatform,
            vrActive: !!session.vrStatusActive,
            firstSlotPlatform: selection.candidates.find(c => !c.gameSlug)?.platform || null,
            rpcEnabled: session.rpcEnabled,
          }).rpcMainPlatform
        : DAEMON_ROLE === 'game'
          ? 'embedded'
          : (hasStatus
              ? (session.statusPlatform || 'mobile')
              : (hasRpc ? (selection.candidates[0]?.platform || 'desktop') : (session.statusPlatform || 'mobile')))
    // 'all' mirrors pushPresenceForUser's combined rule: a Meta Quest slot /
    // active VR status identifies as meta_quest.
    const effectiveTarget = DAEMON_ROLE === 'all'
      ? ((earlyTarget === 'meta_quest' || (hasStatus && session.vrStatusActive)) ? 'meta_quest' : earlyTarget)
      : earlyTarget

    let applied = false
    if (userSock.connected && knownPlatform && knownPlatform !== effectiveTarget) {
      // PLATFORM CHANGE while running → automatic OFF→ON restart of THIS
      // pillar's session. The post-READY forced push applies the latest
      // saved config on the fresh IDENTIFY — the badge flips as fast as
      // Discord's handshake allows (~1-6s) with zero user action.
      console.log(`[10X RPC Daemon] syncUser: platform change ${knownPlatform} -> ${effectiveTarget} for user ${userId} — auto-restarting the session (OFF→ON) to apply the new configuration`)
      this.closeAllSlotSessions(userId)
      this.cleanupSocket(userSock)
      userSock.retryCount = 0
      userSock.identifiedPlatform = undefined
      userSock.lastAppliedFingerprint = undefined // not applied until the new session pushes
      this.clearApplyRetry(userSock)
      if (userSock.retryTimer) {
        clearTimeout(userSock.retryTimer)
        userSock.retryTimer = undefined
      }
      if (!userSock.isConnecting) await this.connectUserSocket(userId)
      // The READY handler pushes the fresh state and stamps the fingerprint;
      // if the handshake stalls, the retry chain below re-verifies.
    } else if (!userSock.connected || !userSock.ws || userSock.ws.readyState !== WebSocket.OPEN) {
      // Half-open / closed / connecting — force a clean reconnect path.
      if (userSock.connected || userSock.ws) this.cleanupSocket(userSock)
      // The user just acted: supersede any scheduled backoff retry.
      if (userSock.retryTimer) {
        clearTimeout(userSock.retryTimer)
        userSock.retryTimer = undefined
      }
      userSock.lastAppliedFingerprint = undefined
      if (!userSock.isConnecting) await this.connectUserSocket(userId)
      // READY pushes fresh state; fingerprint stamps there.
    } else if (userSock.lastAppliedFingerprint === desiredFp) {
      // Everything the user saved is ALREADY the running state (a no-op save
      // or a re-fired sync). Verify cheaply — the hash-guarded push sends
      // nothing unless content actually differs.
      await this.pushPresenceForUser(userId, session, false)
      applied = userSock.lastAppliedFingerprint === desiredFp
    } else {
      // Config changed (or a previous apply never confirmed) → force the
      // apply NOW. pushPresenceForUser stamps the fingerprint on a successful
      // send; platform mismatches inside it re-identify as a fallback.
      await this.pushPresenceForUser(userId, session, true)
      applied = userSock.lastAppliedFingerprint === desiredFp
    }

    // Honest confirmation + intelligent retry: if the apply could not be
    // confirmed yet (handshake in flight / send failed / DB flake), arm the
    // verify chain — it retries with backoff until the running state MATCHES
    // the saved configuration. Recoverable errors only; auth-fatal parks.
    if (!applied) {
      this.scheduleApplyVerify(userId, 'pending apply confirmation')
    } else {
      this.clearApplyRetry(userSock)
    }

    return {
      ok: true,
      method: 'gateway',
      applied,
      message: applied
        ? 'Presence applied & verified — running state matches saved configuration'
        : (userSock.connected
          ? 'Presence applying — verification retry armed until Discord confirms'
          : 'Status session restarting (OFF→ON) — will verify and retry until applied'),
    } as PresenceResult
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
      // Role-staggered refresh window (see tokenRefreshWindowMinutes) — the
      // three nodes must never race Discord's rotating refresh grants.
      if (session.discordTokenExpiresAt && session.discordTokenExpiresAt.getTime() - now.getTime() < tokenRefreshWindowMinutes(DAEMON_ROLE) * 60 * 1000) {
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
      await ensureRpcConfiguredColumn().catch(() => false)
      const rpcConfigs = visibleRpcRows((await db.rpcConfig.findMany({
        where: { userId },
        // createdAt order only — never orderBy `slot` (old daemon clients).
        orderBy: { createdAt: 'asc' },
      }).catch(async () => {
        const r = await db.rpcConfig.findFirst({ where: { userId } }).catch(() => null)
        return r ? [r as RpcCandidate] : []
      })) as Array<RpcCandidate & { enabled: boolean }>)
      // Task 89 — MULTI-GAME: every enabled game runs as its own candidate.
      const enabledGames = await db.gameConfig.findMany({ where: { userId, enabled: true }, orderBy: { createdAt: 'asc' } }).catch(() => [])
      const selection = selectActiveRpcConfigs(session.rpcEnabled, rpcConfigs, enabledGames)
      const isRpcActive = selection.active
      const isStatusActive = !!session.statusEnabled

      // Role-gated IDENTIFY platform (daemon-roles.ts contract — the three
      // nodes must never IDENTIFY the same platform class for one user):
      //   status → the user's chosen badge platform (mobile / None / VR)
      //   rpc    → pre-split rule (first slot's platform) when Status is off;
      //            plain desktop when the status role owns the badge session
      //   game   → always the embedded console class
      //   all    → the exact pre-split precedence
      let targetPlatform: string
      if (DAEMON_ROLE === 'status') {
        targetPlatform = session.vrStatusActive || session.statusPlatform === 'meta_quest'
          ? 'meta_quest'
          : (session.statusPlatform || 'mobile')
      } else if (DAEMON_ROLE === 'rpc') {
        targetPlatform = planRolePresencePlatforms({
          statusEnabled: isStatusActive,
          statusPlatform: session.statusPlatform,
          vrActive: !!session.vrStatusActive,
          firstSlotPlatform: selection.candidates.find(c => !c.gameSlug)?.platform || null,
          rpcEnabled: session.rpcEnabled,
        }).rpcMainPlatform
      } else if (DAEMON_ROLE === 'game') {
        targetPlatform = planRolePresencePlatforms({
          statusEnabled: isStatusActive,
          statusPlatform: session.statusPlatform,
          vrActive: !!session.vrStatusActive,
          firstSlotPlatform: null,
          rpcEnabled: session.rpcEnabled,
        }).gameMainPlatform
      } else {
        const activePlatform = isStatusActive
          ? (session.statusPlatform || 'mobile')
          : (isRpcActive ? (selection.candidates[0]?.platform || 'desktop') : (session.statusPlatform || 'mobile'))

        const isQuest = activePlatform === 'meta_quest' || (isStatusActive && session.vrStatusActive)
        targetPlatform = isQuest ? 'meta_quest' : activePlatform
      }
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

  // ── Task 99 — APPLY-VERIFY-RETRY chain ─────────────────────────────────
  // Users with an apply-verify pass currently executing (single-flight for
  // the RETRY chain and the tick drift-check; direct /sync user actions are
  // never blocked — they are the highest-priority signal).
  private verifyingUsers = new Set<string>()

  /**
   * Arm the intelligent retry chain for a user whose apply could not be
   * confirmed. Backoff 1s → 2s → 4s → 8s → 16s (cap 15s), max 6 attempts per
   * trigger — then the 10s tick's fingerprint drift-check takes over as the
   * infinite safety net. Prevents duplicate chains (single-flight) and never
   * rapid-loops. Auth-fatal users are skipped (unblocked by a new token).
   */
  private scheduleApplyVerify(userId: string, reason: string): void {
    const userSock = this.sockets.get(userId)
    if (!userSock) return
    if (userSock.failedAuthToken) return // parked until the token changes
    if (userSock.applyRetryTimer) return // chain already armed — single-flight
    const attempt = (userSock.applyRetryCount ?? 0) + 1
    if (attempt > 6) {
      // Bounded chain exhausted — reset the counter so the NEXT trigger (the
      // 10s tick's drift-check re-runs syncUser) starts a fresh chain. No
      // infinite rapid loops: the tick paces retries at ≥10s forever.
      userSock.applyRetryCount = 0
      console.warn(`[10X RPC Daemon] Apply verify for user ${userId}: retry chain exhausted (${reason}) — re-arming on the next tick drift-check`)
      return
    }
    const delay = Math.min(15000, 1000 * Math.pow(2, attempt - 1))
    console.log(`[10X RPC Daemon] Apply NOT confirmed for user ${userId} (${reason}) — retry #${attempt} in ${delay}ms`)
    userSock.applyRetryCount = attempt
    userSock.applyRetryTimer = setTimeout(() => {
      const sock = this.sockets.get(userId)
      if (sock) sock.applyRetryTimer = undefined
      void this.runApplyVerify(userId)
    }, delay)
  }

  /** One apply-verify attempt: re-run syncUser (fresh DB read + force apply +
   *  honest confirmation) unless a verify is already executing for the user. */
  private async runApplyVerify(userId: string): Promise<void> {
    if (this.verifyingUsers.has(userId)) {
      // A verify is in flight — it will arm the next attempt itself if needed.
      const sock = this.sockets.get(userId)
      if (sock && !sock.applyRetryTimer) this.scheduleApplyVerify(userId, 'rescheduled while verify in flight')
      return
    }
    this.verifyingUsers.add(userId)
    try {
      const result = await this.syncUser(userId)
      if (!result?.ok) {
        // syncUser reports failure (no session / suspended / DB error) — keep
        // the chain alive for recoverable errors; auth-fatal parks itself.
        const sock = this.sockets.get(userId)
        if (!sock || !sock.failedAuthToken) this.scheduleApplyVerify(userId, result?.message || 'sync failed')
      } else if (!(result as { applied?: boolean }).applied) {
        // Dispatched but not yet confirmed (e.g. re-identify handshake in
        // flight) — keep verifying until the fingerprint stamps.
        this.scheduleApplyVerify(userId, 'apply not confirmed yet')
      } else {
        const sock = this.sockets.get(userId)
        if (sock) sock.applyRetryCount = 0
        console.log(`[10X RPC Daemon] Apply VERIFIED for user ${userId} — running state matches saved configuration`)
      }
    } catch (err) {
      console.warn(`[10X RPC Daemon] Apply verify attempt failed for user ${userId}:`, err instanceof Error ? err.message : err)
      this.scheduleApplyVerify(userId, 'verify attempt threw')
    } finally {
      this.verifyingUsers.delete(userId)
    }
  }

  /** Clear any pending apply-retry state (on verified apply / disconnect). */
  private clearApplyRetry(userSock: ActiveUserSocket): void {
    if (userSock.applyRetryTimer) {
      clearTimeout(userSock.applyRetryTimer)
      userSock.applyRetryTimer = undefined
    }
    userSock.applyRetryCount = 0
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
    if (!userSock || !userSock.ws || userSock.ws.readyState !== WebSocket.OPEN) {
      // Task 99 — never silent: a connected-flagged socket with a non-OPEN ws
      // is exactly the stale state that made updates vanish undiagnosed.
      if (userSock?.connected) console.warn(`[10X RPC Daemon] pushPresenceForUser for user ${userId}: socket flagged connected but ws readyState=${userSock.ws?.readyState ?? 'null'} — treating as disconnected`)
      return
    }
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
      // Task 111 — the column must exist before any generated-client read.
      await ensureRpcConfiguredColumn().catch(() => false)
      const [rpc, glob, games] = await Promise.all([
        // createdAt order only — never orderBy `slot` (old daemon clients).
        // A DB failure here must NEVER be read as "no slots" — that would
        // clear the user's live presence; bail out and retry next tick.
        db.rpcConfig.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
        db.globalConfig.findUnique({ where: { userId } }),
        // Task 89 — MULTI-GAME: every enabled game is a live candidate.
        db.gameConfig.findMany({ where: { userId, enabled: true }, orderBy: { createdAt: 'asc' } }),
      ])
      // Task 111 — unconfigured placeholder rows are invisible to the runtime:
      // no fingerprint input, no rotation member, no platform anchor.
      rpcConfigs = visibleRpcRows(rpc) as Array<RpcCandidate & { enabled: boolean }>
      globalConfig = glob
      enabledGames = (games ?? []) as GameCfgRow[]
    } catch (dbErr) {
      console.warn(`[10X RPC Daemon] Transient DB error in pushPresenceForUser for user ${userId}:`, dbErr)
      return
    }

    // Task 99 — the desired saved-config fingerprint (role-scoped). Stamped
    // as lastAppliedFingerprint ONLY after a successful OP 3 send below, so
    // "fingerprint applied" always means "Discord-facing push completed".
    userSock.desiredFingerprint = presenceConfigFingerprint(
      session,
      rpcConfigs,
      enabledGames.filter((g): g is NonNullable<typeof g> => !!g),
      (globalConfig as { rotatorEnabled?: boolean | null } | null)?.rotatorEnabled,
      // Task 107 — rotation settings are part of the rpc fingerprint now.
      globalConfig,
    )

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
    // Task 106 — allRpcConfigs passes EVERY slot row (enabled AND disabled):
    // the explicit rotation selection matches against ALL created slots, so a
    // DISABLED slot the user selected still takes its turn on Discord.
    const fullSelection = selectActiveRpcConfigs(session.rpcEnabled, rpcConfigs, enabledGames)
    const runtime = resolveRuntimeCandidates({
      rpcEnabled: session.rpcEnabled,
      rpcConfigs,
      allRpcConfigs: rpcConfigs as Array<RpcCandidate & { slot?: number }>,
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

    // ── Role view (daemon-roles.ts) — what THIS daemon pushes for the user ─
    const wantsStatusPillar = roleWantsStatus(DAEMON_ROLE)
    const wantsRpcPillar = roleWantsRpc(DAEMON_ROLE)
    const wantsGamePillar = roleWantsGame(DAEMON_ROLE)
    const plan = planRolePresencePlatforms({
      statusEnabled: isStatusActive,
      statusPlatform: session.statusPlatform,
      vrActive: !!session.vrStatusActive,
      // Task 106 — when every ENABLED slot is off but the rotation pool
      // carries disabled-but-selected slots, the main session still needs a
      // STABLE platform anchor: fall back to the first created slot (enabled
      // or not) so the plan never degrades to the desktop class mid-rotation.
      firstSlotPlatform: fullSelection.candidates.find(c => !c.gameSlug)?.platform
        || (rpcConfigs as Array<RpcCandidate>).find(c => !c.gameSlug)?.platform
        || null,
      rpcEnabled: session.rpcEnabled,
    })
    // Pillar activity from the FULL candidate list (rotation-independent):
    const fullSlots = fullSelection.candidates.filter(c => !c.gameSlug)
    const fullGames = fullSelection.candidates.filter(c => !!c.gameSlug)
    // DEVICE-SELECTION RULE — a Game RPC card is live whenever the user has
    // an enabled game: the game role's main card owns the 'embedded' label,
    // so None-platform slot cards must dodge to 'samsung' (see
    // resolveRpcMainCardLabel) and extras must reserve 'embedded'.
    const gameActive = fullGames.length > 0
    const pillarsActive = {
      status: isStatusActive,
      // Task 106 — rotate/single mode publishes the pool's slot card even when
      // NO enabled slot exists (disabled-but-selected rotation): the pillar is
      // active whenever the runtime is actually sending a slot card.
      rpc: isRpcActive && (fullSlots.length > 0 || runtime.candidates.some(c => !c.gameSlug)),
      game: isRpcActive && fullGames.length > 0,
    }

    // Socket IDENTIFY platform — role-gated (see connectUserSocket); the
    // 'all' daemon keeps the exact pre-split precedence.
    let targetPlatform: string
    if (DAEMON_ROLE === 'status') {
      targetPlatform = plan.statusSessionPlatform
    } else if (DAEMON_ROLE === 'rpc') {
      targetPlatform = plan.rpcMainPlatform
    } else if (DAEMON_ROLE === 'game') {
      targetPlatform = plan.gameMainPlatform
    } else {
      const activePlatform = isStatusActive
        ? (session.statusPlatform || 'mobile')
        : (isRpcActive ? (fullSelection.candidates[0]?.platform || 'desktop') : (session.statusPlatform || 'mobile'))
      // Same VR/platform unification as connectUserSocket — the IDENTIFY
      // properties and the OP 3 payload must always agree.
      const isQuest = activePlatform === 'meta_quest' || (isStatusActive && session.vrStatusActive)
      targetPlatform = isQuest ? 'meta_quest' : activePlatform
    }

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
    // Task 99 — the comparison falls back to the seeded/last-known platform
    // when identifiedPlatform is undefined (a connected socket of unknown
    // identify must not silently skip the restart), and the restart resets
    // the applied fingerprint (nothing counts as "applied" until the fresh
    // session's post-READY push completes).
    const knownPlatform = userSock.identifiedPlatform ?? userSock.platform
    if (userSock.connected && knownPlatform && knownPlatform !== targetPlatform) {
      console.log(`[10X RPC Daemon] Platform change for user ${userId}: ${knownPlatform} -> ${targetPlatform} — re-identifying gateway session`)
      // Extras re-identify on the next maintenance pass too.
      this.closeAllSlotSessions(userId)
      this.cleanupSocket(userSock)
      userSock.retryCount = 0
      userSock.identifiedPlatform = undefined
      userSock.lastAppliedFingerprint = undefined
      this.clearApplyRetry(userSock)
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
    // candidate the user left OUT of the pool keeps its own always-visible
    // extra session.
    // Task 95 — GAME AUTO-ROTATE INDEPENDENCE: games NEVER join the Normal
    // rotation pool anymore (rotationPoolCandidates filters them out), so the
    // enabled game is ALWAYS a pinned extra session here while the slots
    // rotate in the main session. The game's own lifecycle (single-active +
    // interval switches) is managed exclusively by the reconcileGameRotation
    // step at the top of syncAllUsers — the two systems never touch each
    // other's state.
    const rotatePoolKeySet = new Set(runtime.rotatePoolKeys ?? [])
    // Role-gated pinned extras: 'all' keeps the pre-split list (games AND
    // left-out slots); the rpc role only pins NON-game candidates it left out
    // of its rotation pool (games belong to the game role); the game role has
    // no rotate-pinned extras (it pushes every enabled game directly).
    const rotateGameExtras: RpcCandidate[] = !wantsRpcPillar || !isRpcActive || runtime.runtimeMode !== 'rotate'
      ? []
      : DAEMON_ROLE === 'rpc'
        ? fullSelection.candidates.filter(c => !rotatePoolKeySet.has(rpcCandidateKey(c)) && !c.gameSlug)
        : fullSelection.candidates.filter(c => !rotatePoolKeySet.has(rpcCandidateKey(c)))
    // Game candidates this daemon resolves app ids for: 'all' keeps the
    // pre-split list; the game role resolves for every enabled game; the
    // rpc/status roles never push games.
    const gameCandidates: RpcCandidate[] = DAEMON_ROLE === 'all'
      ? [...runtime.candidates.filter(c => c.gameSlug), ...rotateGameExtras]
      : wantsGamePillar
        ? [...fullGames]
        : []
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
    // Role flags — the rpc role multi-sessions its SLOTS (games excluded —
    // they render on the game role); the game role multi-sessions its games.
    const roleSlotCandidates = wantsRpcPillar && DAEMON_ROLE !== 'all'
      ? runtime.candidates.filter(c => !c.gameSlug)
      : []
    const multiSessionRpc = DAEMON_ROLE === 'rpc' && isRpcActive
      && runtime.runtimeMode === 'simultaneous'
      && roleSlotCandidates.length >= 2
    const rotatePinnedRpc = DAEMON_ROLE === 'rpc' && rotateGameExtraActive
    const roleGameCandidates = DAEMON_ROLE === 'game'
      ? fullGames
      : []
    const multiSessionGame = DAEMON_ROLE === 'game' && isRpcActive
      && roleGameCandidates.length >= 2

    // ── Task 92 — GLOBAL DISPLAY-TYPE ORCHESTRATION (the "only one RPC
    // shows" fix) ────────────────────────────────────────────────────────────
    // Discord's client prunes the profile activity list: at most ONE
    // PLAYING-type card renders and (type, application_id, name) duplicates
    // collapse (verified in the shipped client bundle 2026-10-14 — see
    // rpc-manager.assignDisplayTypes). Assign display types across ALL THREE
    // systems (slots + games + Application RPC) so every simultaneous card
    // survives the client-side prune. Deterministic from saved configs → both
    // daemons independently reach the same assignment.
    if (isRpcActive && (DAEMON_ROLE === 'all' || DAEMON_ROLE === 'rpc')) {
      const appRpcRow = await fetchAppRpcTypeRow(userId)
      // Task 92 — the display-type assignment is GLOBAL across slots + games
      // + the Application RPC. The rpc role still feeds the GAME candidates
      // into the inputs (pinned PLAYING, Task 93) so its slot types come out
      // IDENTICAL to the combined daemon's — the game cards live on the game
      // role, but the at-most-one-non-game-PLAYING rule sees them.
      // Task 107 — ONE shared input builder for ALL surfaces (rpc-daemon,
      // application-rpc-daemon, /api/me — see buildGlobalDisplayTypeInputs).
      // In Auto-Rotate mode the slots input is EVERY created slot (enabled
      // AND disabled): a disabled-but-selected slot IS pushed during its
      // rotation turn and must be part of the assignment — before this fix
      // it was missing, kept its configured PLAYING, and the client pruned
      // it against the game's pinned PLAYING card ("RPC3 not showing during
      // its turn"). Non-rotate modes keep the enabled-slots-only pushed set.
      const globalTypeInputs: DisplayTypeCandidate[] = buildGlobalDisplayTypeInputs({
        slots: runtime.runtimeMode === 'rotate'
          ? (sortedSlotRows(rpcConfigs as Array<RpcCandidate & { slot?: number }>))
          : fullSelection.candidates,
        games: fullGames,
        appRpc: appRpcRow,
      })
      // Task 105 — GAME CANDIDATES FIRST (the shared builder already emits
      // games first — kept as an invariant note). The client prune keeps
      // exactly ONE PLAYING activity GLOBALLY (Task 92 bundle verification:
      // display = prune(uniqBy(type:app:name))), and the Task 93 pin makes
      // every enabled game PLAYING. Task 107 — a pinned game also CONSUMES
      // the global PLAYING position inside assignDisplayTypes, so every
      // non-game candidate deterministically yields to a substitute type.
      const orderedTypeInputs: DisplayTypeCandidate[] = globalTypeInputs
      if (DAEMON_ROLE === 'rpc') {
        // Role view — apply over the rpc role's own candidates only.
        if (multiSessionRpc) {
          const displayTypes = assignDisplayTypes(orderedTypeInputs)
          for (const c of roleSlotCandidates) {
            const t = displayTypes.get(rpcCandidateKey(c))
            if (t && t !== c.type) c.type = t
          }
        } else if (isRpcActive && runtime.runtimeMode === 'rotate') {
          // Task 107 — ALL Auto-Rotate mode (with AND without pinned extras).
          // The pinned-game card is PLAYING (Task 93, game role), so the
          // ROTATING main card must deterministically yield to a substitute
          // type — the client prune keeps exactly ONE PLAYING activity
          // GLOBALLY, and before this fix the rotating card kept its
          // configured PLAYING whenever NO slot was left out of the pool
          // (the most common setup: game enabled + every selected slot in the
          // rotation) → two PLAYING cards → one pruned → the rotating RPC
          // vanished from Discord (the "Auto-Rotate RPC not showing" bug).
          // Task 109 — the ROTATING card owns the PLAYING position when it is
          // free: without the preferred key the FIRST slot in the inputs
          // consumed PLAYING even though only the rotating card is pushed,
          // so turns of slot 2/3 degraded to "Competing in 10X RPC" even with
          // NO game on the profile.
          const neverPlaying = new Set<string>(
            rotateGameExtras.filter(c => !c.gameSlug).map(c => rpcCandidateKey(c))
          )
          if (appRpcRow) neverPlaying.add('app_rpc')
          const rotatingCandidate = runtime.candidates[0]
          const preferredPlayingKey = rotatingCandidate && !rotatingCandidate.gameSlug
            ? rpcCandidateKey(rotatingCandidate)
            : null
          const displayTypes = assignDisplayTypes(orderedTypeInputs, neverPlaying, preferredPlayingKey)
          // The rotating MAIN card (runtime.candidates[0] — the publishable
          // rotation copy) takes the assignment first.
          if (rotatingCandidate && !rotatingCandidate.gameSlug) {
            const t = displayTypes.get(rpcCandidateKey(rotatingCandidate))
            if (t && t !== rotatingCandidate.type) rotatingCandidate.type = t
          }
          for (const c of rotateGameExtras) {
            const t = displayTypes.get(rpcCandidateKey(c))
            if (t && t !== c.type) c.type = t
          }
        } else if (isRpcActive && runtime.runtimeMode === 'simultaneous') {
          // Task 105 — SINGLE-SLOT simultaneous mode MUST run the same
          // assignment. Skipping it here is what made RPC2 invisible whenever
          // it was the only enabled slot: the lone slot kept PLAYING and the
          // client pruned it against the game role's pinned PLAYING card.
          const displayTypes = assignDisplayTypes(orderedTypeInputs)
          for (const c of roleSlotCandidates) {
            const t = displayTypes.get(rpcCandidateKey(c))
            if (t && t !== c.type) c.type = t
          }
        }
      } else if (multiSessionActive) {
        const displayTypes = assignDisplayTypes(orderedTypeInputs)
        for (const c of runtime.candidates) {
          const t = displayTypes.get(rpcCandidateKey(c))
          if (t && t !== c.type) c.type = t
        }
      } else if (isRpcActive && runtime.runtimeMode === 'rotate') {
        // Task 107 — combined-daemon Auto-Rotate branch (covers rotate WITH
        // and WITHOUT pinned extras — it subsumes the old rotateGameExtra-
        // Active-only branch, which missed the plain-rotate case entirely).
        // The pinned-game card is PLAYING (Task 93), so the rotating main
        // card must yield to a substitute type — otherwise two PLAYING
        // activities coexist and the client prune removes one (the rotating
        // RPC vanished whenever a game was enabled). Pinned slot extras and
        // the Application RPC never present as PLAYING while rotation runs.
        // Task 109 — the ROTATING card owns the free PLAYING position (same
        // as the rpc-role branch above — without it slot 2/3 turns rendered
        // as "Competing in …" when no game owned PLAYING).
        const neverPlaying = new Set<string>(
          rotateGameExtras.filter(c => !c.gameSlug).map(c => rpcCandidateKey(c))
        )
        if (appRpcRow) neverPlaying.add('app_rpc')
        const rotatingCandidate = runtime.candidates[0]
        const preferredPlayingKey = rotatingCandidate && !rotatingCandidate.gameSlug
          ? rpcCandidateKey(rotatingCandidate)
          : null
        const displayTypes = assignDisplayTypes(orderedTypeInputs, neverPlaying, preferredPlayingKey)
        if (rotatingCandidate && !rotatingCandidate.gameSlug) {
          const t = displayTypes.get(rpcCandidateKey(rotatingCandidate))
          if (t && t !== rotatingCandidate.type) rotatingCandidate.type = t
        }
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
    const extrasSource: ExtraSource[] =
      DAEMON_ROLE === 'all'
        ? (multiSessionActive
            // Simultaneous mode: every candidate beyond the first (existing
            // Task 84 behavior — slots AND games).
            ? runtime.candidates.slice(1, 5).map(cand => ({ cand, hint: stableHintOf(cand) }))
            : rotateGameExtraActive
              // Rotate mode: exactly the pinned game candidates — they stay
              // visible in their own sessions while the pool rotates.
              ? rotateGameExtras.slice(0, 4).map(cand => ({ cand, hint: stableHintOf(cand) }))
              : [])
        : DAEMON_ROLE === 'rpc'
          ? (multiSessionRpc
              ? roleSlotCandidates.slice(1, 5).map(cand => ({ cand, hint: stableHintOf(cand) }))
              : rotatePinnedRpc
                ? rotateGameExtras.slice(0, 4).map(cand => ({ cand, hint: stableHintOf(cand) }))
                : [])
          : DAEMON_ROLE === 'game'
            ? (multiSessionGame
                ? roleGameCandidates.slice(1, 5).map((cand, gi) => ({ cand, hint: gi }))
                : [])
            : []
    if (extrasSource.length > 0) {
      // VR stamping belongs to the status role's badge session; role daemons
      // other than 'all' never mark extras meta_quest (label collision-safe).
      const globalVr = DAEMON_ROLE === 'all'
        ? ((isStatusActive && (session.statusPlatform === 'meta_quest' || session.vrStatusActive)) || (isRpcActive && fullSelection.candidates[0]?.platform === 'meta_quest'))
        : false
      const globalPlatform = DAEMON_ROLE === 'all'
        ? (isRpcActive ? (fullSelection.candidates[0]?.platform || 'desktop') : targetPlatform)
        : targetPlatform
      // Task 84c/84d — every extra card needs a DISTINCT activity-platform
      // label (the merge key Discord uses for concurrent cards; two cards
      // with the same label merge and only one renders). The pool is the
      // ICON-LESS ladder (embedded → samsung → ios → android — see
      // EXTRA_PLATFORM_FALLBACK_POOL): NO PlayStation/Xbox/Meta Quest label
      // is ever auto-assigned — a device badge may only appear when the user
      // explicitly picked that device in the RPC DEVICE/PLATFORM selector.
      // 5 labels total = main + 4 extras max.
      // GAME role — its own collision-safe pool instead (its main session
      // already occupies 'embedded'): labels no other role emits.
      // Task 110 + DEVICE-SELECTION RULE — the MAIN card's label is TAKEN for
      // extras: two cards with the same activity-platform label merge
      // client-side (Task 91). The main label now follows the explicit-only
      // rule (resolveRpcMainCardLabel): the slot's own device when the user
      // picked one, else the icon-less 'embedded'/'samsung' label. The Game
      // role's 'embedded' main-card label is RESERVED while a game is live so
      // no extra can merge into the game card.
      const extrasMainLabel = DAEMON_ROLE === 'rpc'
        ? (roleSlotCandidates[0]
            ? (resolveRpcMainCardLabel(roleSlotCandidates[0].platform, gameActive) ?? targetPlatform)
            : targetPlatform)
        : targetPlatform
      const platformAssignments: Array<string | null> = DAEMON_ROLE === 'game'
        ? []
        : assignSessionPlatforms(
            extrasMainLabel,
            extrasSource.map(e => e.cand.platform),
            // Task 84d — STABLE per-candidate hints (see allConfigIndex above):
            // toggling a middle slot never reshuffles the others (no reopen
            // churn / zombie sessions / card flicker).
            extrasSource.map(e => e.hint),
            // The game role's main card owns 'embedded' while a Game RPC is
            // live — extras must never take a label the game card wears.
            gameActive ? RESERVED_GAME_MAIN_LABEL : undefined
          )
      for (let i = 0; i < extrasSource.length && extras.length < 4; i++) {
        const cand = extrasSource[i].cand
        const assignedPlatform = DAEMON_ROLE === 'game'
          ? (GAME_EXTRA_PLATFORM_POOL[i] ?? null)
          : platformAssignments[i]
        if (!assignedPlatform) {
          // No free platform class — in simultaneous mode fold back into the
          // main push so the candidate never vanishes. In rotate+game-pinned
          // mode there is no fold-back (the game is intentionally NOT in the
          // main rotation push) — it just waits for the next tick's retry.
          const foldBack = DAEMON_ROLE === 'all' ? multiSessionActive : multiSessionRpc
          if (foldBack) mainFallback.push(cand)
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
            const foldBack = DAEMON_ROLE === 'all' ? multiSessionActive : multiSessionRpc
            if (foldBack) mainFallback.push(cand)
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
            // contains valid, ICON-LESS activity-enum values (embedded /
            // samsung / ios / android), so every card carries a UNIQUE label,
            // can neither merge with a sibling nor be wiped by a real
            // client's push, and never shows an unselected device badge.
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
              idx: (DAEMON_ROLE === 'all' ? multiSessionActive : (multiSessionRpc || multiSessionGame)) ? i + 1 : 0,
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

    // Main-session payload — role-gated:
    //   status → ONLY the custom status activity (the badge session carries
    //            no cards; cards belong to the rpc/game roles)
    //   rpc    → the role's slot candidates (rotate: the rotating slot)
    //   game   → the first enabled game (extras carry the rest)
    //   all    → the exact pre-split payload
    let mainPushCandidates: RpcCandidate[] = []
    if (DAEMON_ROLE === 'status') {
      mainPushCandidates = []
    } else if (DAEMON_ROLE === 'rpc') {
      mainPushCandidates = !isRpcActive
        ? []
        : multiSessionRpc
          ? [roleSlotCandidates[0], ...mainFallback]
          : roleSlotCandidates
    } else if (DAEMON_ROLE === 'game') {
      mainPushCandidates = isRpcActive ? roleGameCandidates.slice(0, 1) : []
    } else {
      mainPushCandidates = isRpcActive
        ? (multiSessionActive ? [runtime.candidates[0], ...mainFallback] : runtime.candidates)
        : []
    }
    const mainCustomStatus = DAEMON_ROLE === 'all'
      ? (isStatusActive ? session.customStatus : null)
      : (wantsStatusPillar && isStatusActive ? session.customStatus : null)
    const mainCustomStatusEmoji = DAEMON_ROLE === 'all'
      ? (isStatusActive ? session.customStatusEmoji : null)
      : (wantsStatusPillar && isStatusActive ? session.customStatusEmoji : null)
    const mainVrStatusActive = DAEMON_ROLE === 'all'
      ? ((isStatusActive && (session.statusPlatform === 'meta_quest' || session.vrStatusActive)) || (isRpcActive && fullSelection.candidates[0]?.platform === 'meta_quest'))
      : DAEMON_ROLE === 'status'
        ? (isStatusActive && (session.statusPlatform === 'meta_quest' || session.vrStatusActive))
        : false
    const activities = await buildPresenceActivities({
      rpcConfigs: mainPushCandidates,
      customStatus: mainCustomStatus,
      customStatusEmoji: mainCustomStatusEmoji,
      placeholderCtx,
      vrStatusActive: mainVrStatusActive,
      platform: DAEMON_ROLE === 'all'
        ? (isRpcActive ? (fullSelection.candidates[0]?.platform || 'desktop') : targetPlatform)
        : targetPlatform,
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
    // GAME role — stamp the main card's activity-level platform label (Task 91
    // doctrine: the label is the card merge key). 'embedded' is a valid enum
    // value and collides with neither the rpc role's cards nor the user's
    // real clients — the game card can never be wiped by a desktop push.
    if (DAEMON_ROLE === 'game' && safeActivities.length > 0 && isValidActivityPlatform(plan.gameMainLabel)) {
      safeActivities[0].platform = plan.gameMainLabel
    }
    // RPC role — DEVICE-SELECTION RULE (explicit-only badges): the main card
    // keeps the slot's CONFIGURED device label (ps4/ps5/xbox/meta_quest — the
    // RPC DEVICE/PLATFORM feature the user picked) and gets an ICON-LESS
    // label ('embedded', or 'samsung' while a Game RPC card is live so the
    // two main cards never share the Task 91 merge key) for None/desktop/
    // legacy configs. The builder's own stamp (cfg.platform — overwhelmingly
    // 'desktop') is always overridden: a desktop-labeled card is wiped by the
    // user's REAL desktop client (live-verified, Task 91), and a None slot
    // must never wear a device badge it never picked (the old ps4 anchor).
    // Hardening: a legacy/invalid enum value ('console', 'web', …) riding the
    // builder's stamp would get the WHOLE activity rejected by the gateway
    // (Task 84d) — strip it before re-labeling.
    if (DAEMON_ROLE === 'rpc' && safeActivities.length > 0) {
      const builderStamp = (safeActivities[0] as { platform?: unknown }).platform
      if (typeof builderStamp === 'string' && !isValidActivityPlatform(builderStamp)) {
        delete (safeActivities[0] as { platform?: string }).platform
      }
      const mainCardLabel = resolveRpcMainCardLabel(mainPushCandidates[0]?.platform, gameActive)
      if (mainCardLabel) {
        safeActivities[0].platform = mainCardLabel
      }
    }

    // OP 3 status field per role. Discord IGNORES this field for OAuth/sdk
    // sessions (Task 97) — the account-level REST patch below is what renders
    // — but the values stay consistent with the pre-split ones.
    const status = DAEMON_ROLE === 'all'
      ? (isStatusActive ? (session.userStatus || 'online') : (isRpcActive ? 'online' : 'invisible'))
      : (isStatusActive ? (session.userStatus || 'online') : 'online')

    // ── ACCOUNT-STATUS SELF-HEAL (Task 97 — the "status not working" fix) ──
    // Discord IGNORES the `status` field of OP 3 presence updates for
    // OAuth/sdk sessions (live-verified 2026-10-15 on both gateways — the
    // activities in the SAME OP 3 still apply, the status does not). The
    // profile status is pinned to the ACCOUNT-level user_settings.status and
    // the honored write path is REST PATCH /users/@me/settings — exactly what
    // the real client does. Whenever the desired status differs from the
    // account status we last applied, PATCH it. Idempotent: fires on a real
    // change (user pick / toggle / first push after restart) — never per tick.
    // The website's /api/status/update also patches instantly; this loop is
    // the self-healing authority (covers drift, daemon restarts, toggles).
    // Exactly ONE daemon patches the account status for a user (Task 97 + the
    // NODE 1/2/3 split): Status enabled → the status role; else Normal slots
    // active → the rpc role; else Game RPC → the game role. The combined 'all'
    // daemon keeps the unconditional pre-split behavior (transition-safe: its
    // values agree with the owners').
    const iPatchAccountStatus = accountStatusPatchOwner({
      role: DAEMON_ROLE,
      statusEnabled: isStatusActive,
      slotsActive: pillarsActive.rpc,
      gamesActive: pillarsActive.game,
    })
    if (iPatchAccountStatus && userSock.lastAccountStatus !== status && session.discordAccessToken) {
      const patched = await patchDiscordAccountSettings(session.discordAccessToken, { status })
      if (patched.ok) {
        userSock.lastAccountStatus = status
      } else {
        console.warn(`[10X RPC Daemon] Account status patch failed for user ${userId} (${status}): ${patched.error} — will retry next tick`)
      }
    }
    const activitiesHash = JSON.stringify({ status, activities: safeActivities })

    // MULTI-SESSION maintenance — extras carry their own hash guards, so this
    // is cheap every tick and recovers dead sessions even when the main push
    // is unchanged. Auto Rotate (game included) / single-candidate / RPC-off
    // → closes extras. Rotate with the game PINNED keeps its extra alive.
    const extrasActive = DAEMON_ROLE === 'all'
      ? (multiSessionActive || rotateGameExtraActive)
      : DAEMON_ROLE === 'rpc'
        ? (multiSessionRpc || rotatePinnedRpc)
        : DAEMON_ROLE === 'game'
          ? multiSessionGame
          : false
    this.maintainSlotSessions(userId, session.discordAccessToken ?? '', status, extras, extrasActive)

    // Avoid spamming identical OP 3 payloads unless forced (prevents rate limits)
    if (!force && userSock.lastActivitiesHash === activitiesHash && userSock.lastStatus === status) {
      return
    }

    if ((DAEMON_ROLE === 'all' || DAEMON_ROLE === 'rpc') && isRpcActive && runtime.runtimeMode === 'rotate' && runtime.rotateIndex != null) {
      const allSlotsCount = (rpcConfigs as Array<{ gameSlug?: string }>).filter(c => !c.gameSlug).length
      const poolNote = Array.isArray(rotate.slots)
        ? `, selection: ${runtime.rotatePoolLength} of ${allSlotsCount} RPCs${rotateGameExtraActive ? `, ${rotateGameExtras.length} left-out RPC(s) stay visible` : ''}`
        : `${rotate.includeGame ? '' : ', excluded games pinned to their own sessions'}`
      console.log(`[10X RPC Daemon] Auto Rotate for user ${userId}: candidate ${runtime.rotateIndex + 1}/${runtime.rotatePoolLength ?? allSlotsCount} (${runtime.candidates[0]?.name ?? '?'}) every ${rotate.secs}s, order=${rotate.order}${rotate.skip > 0 ? `, skip+${rotate.skip}` : ''}${poolNote}`)
    }

    // If socket is open and payload is ready, send OP 3 — Task 99: never
    // silent. A non-OPEN socket at this point (after passing the connected
    // gate above) means the connection died mid-build; log it so the retry
    // chain's reason is diagnosable.
    if (!userSock.ws || userSock.ws.readyState !== WebSocket.OPEN) {
      console.warn(`[10X RPC Daemon] OP 3 for user ${userId} aborted: socket closed while building payload (readyState=${userSock.ws?.readyState ?? 'null'})`)
      return
    }

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
      // Task 99 — the send completed without throwing: the running state now
      // MATCHES the saved configuration. Stamp the verified fingerprint so
      // the sync/tick drift-checks see consistency (and clear any retry
      // backoff counter — the next verify pass will confirm and clean up).
      if (userSock.desiredFingerprint) {
        userSock.lastAppliedFingerprint = userSock.desiredFingerprint
        userSock.applyRetryCount = 0
        console.log(`[10X RPC Daemon] Fingerprint applied & verified for user ${userId} (running state matches saved configuration)`)
      }
    } catch (err) {
      console.error(`[10X RPC Daemon] Failed to send OP 3 for user ${userId}:`, err)
      // Task 99 — deliberately NO fingerprint stamp on failure: the retry
      // chain keeps re-applying until the push actually lands.
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

    // Task 99 — the user is fully gone: no retry chain may outlive them.
    this.clearApplyRetry(userSock)
    this.verifyingUsers.delete(userId)

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

  private closeSlotSession(sess: SlotSession, clearPresenceFirst: boolean = false): void {
    sess.aborted = true
    if (sess.heartbeatTimer) {
      clearInterval(sess.heartbeatTimer)
      sess.heartbeatTimer = undefined
    }
    if (sess.ws) {
      const ws = sess.ws
      // INSTANT CARD CLEAR (multi-RPC reliability): a removed extra session
      // used to just close, and Discord kept the closed session's last card
      // in the user's aggregated presence for its ~1-2 min teardown grace —
      // the disabled slot looked "still on", a stale ghost could sit next to
      // a re-opened session, and rapid toggling piled up zombie sessions
      // against Discord's concurrent-session budget until new extras failed
      // to identify. Pushing an empty OP 3 BEFORE the close makes Discord
      // drop the card immediately; the socket then closes after a short
      // flush window. Used ONLY when the session is being REMOVED — the
      // openSlotSession replacement path keeps the plain close (an immediate
      // clear there would flicker the card off/on on every config edit).
      if (clearPresenceFirst && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({
            op: 3,
            d: { status: sess.lastPushedStatus || 'online', activities: [], afk: false, since: null },
          }))
        } catch {}
        try { ws.removeAllListeners() } catch {}
        try { ws.on('error', () => {}) } catch {}
        setTimeout(() => {
          try {
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate()
            else ws.close()
          } catch {}
        }, 350)
        sess.ws = null
        sess.connected = false
        sess.isConnecting = false
        return
      }
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
   *  token changed, user disconnected). Next multi-session tick re-opens.
   *  Always clears the card first — removal, never replacement. */
  closeAllSlotSessions(userId: string): void {
    const m = this.slotSessions.get(userId)
    if (!m) return
    for (const sess of m.values()) this.closeSlotSession(sess, true)
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
        // Slot disabled / no longer an extra — clear its card instantly, then
        // close (the close alone left the card in Discord's teardown grace).
        this.closeSlotSession(sess, true)
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
      role: DAEMON_ROLE,
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
