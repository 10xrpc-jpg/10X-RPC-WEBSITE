// 10X RPC — Task 111: CONFIGURED-ONLY RPC VISIBILITY
//
// Root cause this module eliminates: legacy builds AUTO-CREATED a default
// "10X RPC" RpcConfig row (empty PLAYING/desktop placeholder) the first time a
// user loaded the dashboard or toggled RPC with nothing configured. Those
// auto-generated rows were then treated like real configurations — rendered as
// RPC cards in the dashboard and even published to Discord ("Watching /
// Competing in 10X RPC" ghost presence with the 10X logo and Discord's own
// "Connect Xbox" prompt).
//
// The fix, applied consistently across DB → APIs → UI → runtime:
//   1. RpcConfig.configured (persisted boolean) is the single source of truth
//      for "the user explicitly configured and saved this RPC". It is set to
//      true ONLY by explicit user actions (config save, enable toggle) and is
//      NEVER flipped back to false. Auto-creation paths are removed entirely.
//   2. Legacy placeholder rows are healed ONCE per user: any existing row that
//      carries real user-entered data (or is live) is backfilled to
//      configured=true — nothing the user actually configured is ever hidden
//      or lost. Bare default placeholders stay false and disappear everywhere.
//   3. Every read path (dashboard APIs, daemon, preview, rotation pool)
//      filters through visibleRpcRows(): the persisted flag when the client
//      knows the column, the same deterministic heuristic otherwise (older
//      standalone daemon Prisma clients predate the column).
//
// This module is intentionally dependency-light (only ./db) so the website,
// the in-process daemon and the standalone 24/7 daemon nodes all share the
// EXACT same visibility rule.

import { db } from './db'

/** The brand default NAME an auto-generated placeholder row carries. */
export const DEFAULT_RPC_NAME = '10X RPC'

/** Minimal row shape the visibility logic needs (works with every client). */
export interface ConfiguredCheckRow {
  enabled?: boolean | null
  configured?: boolean | null
  name?: string | null
  type?: string | null
  platform?: string | null
  state?: string | null
  details?: string | null
  largeImage?: string | null
  largeText?: string | null
  smallImage?: string | null
  smallText?: string | null
  button1Label?: string | null
  button1Url?: string | null
  button2Label?: string | null
  button2Url?: string | null
  appId?: string | null
  partyCurrent?: number | null
  partyMax?: number | null
  partyId?: string | null
  partySecret?: string | null
  startMinsAgo?: number | null
  endTotalMins?: number | null
}

function hasText(v: string | null | undefined): boolean {
  return typeof v === 'string' && v.trim().length > 0
}

/**
 * Deterministic "does this row carry real user-entered configuration?"
 * heuristic — the exact conditions the one-time backfill persists into the
 * `configured` column. A row is configured when ANY of:
 *   • it is (or was) live — enabled=true is always an explicit user action,
 *   • the persisted configured flag is already true,
 *   • ANY field differs from what the legacy auto-creator wrote
 *     (name "10X RPC", type PLAYING, platform desktop, everything else empty).
 */
export function rowLooksConfigured(r: ConfiguredCheckRow | null | undefined): boolean {
  if (!r) return false
  if (r.configured === true) return true
  if (r.enabled === true) return true
  const name = (r.name ?? '').trim()
  if (name && name !== DEFAULT_RPC_NAME) return true
  if ((r.type ?? 'PLAYING') !== 'PLAYING') return true
  if ((r.platform ?? 'desktop') !== 'desktop') return true
  if (hasText(r.state) || hasText(r.details)) return true
  if (hasText(r.largeImage) || hasText(r.largeText)) return true
  if (hasText(r.smallImage) || hasText(r.smallText)) return true
  if (hasText(r.button1Label) || hasText(r.button1Url)) return true
  if (hasText(r.button2Label) || hasText(r.button2Url)) return true
  if (hasText(r.appId)) return true
  if (r.partyCurrent != null || r.partyMax != null) return true
  if (hasText(r.partyId) || hasText(r.partySecret)) return true
  if ((r.startMinsAgo ?? 0) > 0) return true
  if (r.endTotalMins != null) return true
  return false
}

/**
 * The ONLY rows any surface may show or run: the persisted `configured` flag
 * when present, the identical heuristic when a row predates the column
 * (older standalone-daemon Prisma clients simply omit unknown columns).
 */
export function visibleRpcRows<T extends ConfiguredCheckRow>(
  rows: (T | null | undefined)[] | null | undefined
): T[] {
  return (rows ?? []).filter((r): r is T => !!r && rowLooksConfigured(r))
}

// ═════════════════════════════════════════════════════════════════════════
// Self-healing schema guard + one-time backfill
// ═════════════════════════════════════════════════════════════════════════

let columnGuard: Promise<boolean> | null = null

/**
 * Guarantees the RpcConfig.configured column exists BEFORE any generated
 * client query touches the table (a client that knows the column but a DB
 * without it would fail EVERY RpcConfig read). Runs the DDL once per process:
 *   • PostgreSQL (production/Neon): ADD COLUMN IF NOT EXISTS
 *   • SQLite (sandbox/local): ADD COLUMN, tolerating "duplicate column"
 * Never throws — a host without DDL rights simply degrades to the heuristic
 * (visibleRpcRows handles flag-less rows identically).
 */
export function ensureRpcConfiguredColumn(): Promise<boolean> {
  if (!columnGuard) {
    columnGuard = (async () => {
      const url = (process.env.DATABASE_URL || '').trim()
      try {
        // Fast probe first: when the column already exists (prisma db push,
        // a previous boot) this SELECT succeeds and skips the ALTER — and
        // avoids Prisma's noisy internal error logging on SQLite, which has
        // no ADD COLUMN IF NOT EXISTS.
        try {
          await db.$queryRawUnsafe('SELECT "configured" FROM "RpcConfig" LIMIT 1')
          return true
        } catch {
          /* column missing (or table missing) → run the ALTER below */
        }
        if (url.startsWith('file:')) {
          try {
            await db.$executeRawUnsafe(
              'ALTER TABLE "RpcConfig" ADD COLUMN "configured" BOOLEAN NOT NULL DEFAULT 0'
            )
          } catch (e) {
            // SQLite has no IF NOT EXISTS — "duplicate column" means it exists.
            const msg = e instanceof Error ? e.message : String(e)
            if (!/duplicate column/i.test(msg)) throw e
          }
        } else {
          await db.$executeRawUnsafe(
            'ALTER TABLE "RpcConfig" ADD COLUMN IF NOT EXISTS "configured" BOOLEAN NOT NULL DEFAULT false'
          )
        }
        return true
      } catch (e) {
        console.error(
          '[rpc-configured] configured-column guard failed (continuing with heuristic):',
          e instanceof Error ? e.message : e
        )
        return false
      }
    })()
  }
  return columnGuard
}

// One backfill attempt per user per process — after the first success the
// stored flags make the UPDATE a no-op anyway, and capping the set keeps the
// memory bounded on multi-tenant daemons (mirrors recentHeals in rpc-slots).
const backfilledUsers = new Set<string>()
const BACKFILL_MEMO_CAP = 10_000

/**
 * One-time heal: persist configured=true for every existing row that carries
 * REAL user-entered configuration (or is live). Legacy auto-created default
 * placeholders do NOT match and stay hidden. Never deletes, resets or
 * overwrites any field — this only stamps visibility flags.
 */
export async function ensureConfiguredBackfill(userId: string): Promise<void> {
  if (backfilledUsers.has(userId)) return
  backfilledUsers.add(userId)
  if (backfilledUsers.size > BACKFILL_MEMO_CAP) {
    backfilledUsers.clear()
    backfilledUsers.add(userId)
  }
  try {
    await ensureRpcConfiguredColumn()
    await db.rpcConfig.updateMany({
      where: {
        userId,
        configured: false,
        OR: [
          { enabled: true },
          { name: { not: DEFAULT_RPC_NAME } },
          { type: { not: 'PLAYING' } },
          { platform: { not: 'desktop' } },
          { state: { not: null } },
          { details: { not: null } },
          { largeImage: { not: null } },
          { largeText: { not: null } },
          { smallImage: { not: null } },
          { smallText: { not: null } },
          { button1Label: { not: null } },
          { button1Url: { not: null } },
          { button2Label: { not: null } },
          { button2Url: { not: null } },
          { appId: { not: null } },
          { partyCurrent: { not: null } },
          { partyMax: { not: null } },
          { partyId: { not: null } },
          { partySecret: { not: null } },
          { startMinsAgo: { gt: 0 } },
          { endTotalMins: { not: null } },
        ],
      },
      data: { configured: true },
    })
  } catch (e) {
    // Old Prisma clients (standalone daemon nodes pre-deploy) don't know the
    // column — the row-level heuristic keeps their behavior correct anyway.
    console.warn(
      `[rpc-configured] backfill skipped for user ${userId}:`,
      e instanceof Error ? e.message : e
    )
  }
}
