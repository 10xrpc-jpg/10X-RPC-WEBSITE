// 10X RPC — Unified presence-sync entrypoint for ALL write paths.
//
// WHY THIS EXISTS (the "slow Discord profile updates" fix):
// Two Discord gateway sessions used to fight each other:
//   • the 24/7 Orihost daemon (the session that actually owns presence),
//   • a Vercel in-process daemon started on every save (serverless freezes
//     kill its socket → zombie sessions push stale payloads that REVERT what
//     the 24/7 daemon just applied).
// On top of that, the 24/7 daemon only re-read the DB every 30s tick, so even
// a clean save took up to 30s to reach the live session.
//
// NOW: when ORIHOST_DAEMON_URL is configured (production), every save/toggle
// instantly notifies the 24/7 daemon over HTTP (/sync) and the in-process
// daemon is NEVER started — one session, one source of truth, sub-second
// updates. Locally (no ORIHOST_DAEMON_URL) the classic in-process daemon is
// used, unchanged.

import { ensureDaemonRunning, getRpcDaemon } from '@/lib/rpc-daemon'
import type { PresenceResult } from '@/lib/rpc-manager'

export type SyncMode = 'sync' | 'stop'

/**
 * The 24/7 daemon base URLs (production). Supports a COMMA-SEPARATED list —
 * one per Orihost node, one product pillar each:
 *   NODE 1 = STATUS, NODE 2 = RPC, NODE 3 = GAME RPC.
 * Every save/toggle is broadcast to ALL nodes; each node's daemon applies
 * only its own pillar (role-gated) and ignores the rest, so a single
 * notification reaches whichever pillar the change touches.
 */
function orihostDaemonBases(): string[] {
  const raw = process.env.ORIHOST_DAEMON_URL || ''
  return raw
    .split(',')
    .map(s => s.trim().replace(/\/+$/, ''))
    .filter(Boolean)
}

export function orihostDaemonConfigured(): boolean {
  return orihostDaemonBases().length > 0
}

/**
 * Fire an immediate presence sync on the 24/7 Orihost daemon.
 * Returns true when the sync was dispatched (daemon reachable).
 *
 * Latency design: the daemon completes the sync SERVER-SIDE even if this
 * client stops waiting, so we only wait a short window to confirm the
 * connection was accepted. A fast connection failure (daemon down) still
 * reports false; a slow-but-working daemon reports true optimistically and
 * finishes the push in the background.
 */
export async function notifyOrihostSync(
  userId: string,
  mode: SyncMode = 'sync'
): Promise<boolean> {
  const detailed = await notifyOrihostSyncDetailed(userId, mode)
  return detailed.dispatched
}

/**
 * Task 99 — same broadcast as notifyOrihostSync, but aggregates the nodes'
 * per-node `applied` confirmation from the /sync response body. The node that
 * OWNS the changed pillar answers applied:true/false; the other roles no-op.
 */
export async function notifyOrihostSyncDetailed(
  userId: string,
  mode: SyncMode = 'sync'
): Promise<{ dispatched: boolean; applied?: boolean }> {
  const bases = orihostDaemonBases()
  if (bases.length === 0) return { dispatched: false }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    let hardFailures = 0
    const dispatch = (base: string) =>
      fetch(`${base}/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // SECRET-NAME ROBUSTNESS (Task 118): the node historically expected
          // DAEMON_SYNC_SECRET while this side sent ORIHOST_SYNC_SECRET — a
          // name mismatch silently 403'd every instant sync. Send whichever is
          // configured (node side accepts either name too).
          ...(process.env.ORIHOST_SYNC_SECRET || process.env.DAEMON_SYNC_SECRET
            ? { 'x-sync-secret': process.env.ORIHOST_SYNC_SECRET || process.env.DAEMON_SYNC_SECRET }
            : {}),
        },
        body: JSON.stringify({ userId, mode }),
        signal: controller.signal,
      })
        .then(async (res) => {
          if (!res.ok) {
            // 403 here almost always means the node's DAEMON_SYNC_SECRET and
            // this deployment's ORIHOST_SYNC_SECRET hold DIFFERENT values —
            // say so loudly instead of dying silently (Task 118 diagnostics).
            if (res.status === 403) {
              console.error(`[presence-sync] ${base}/sync → 403 invalid_secret — the node's DAEMON_SYNC_SECRET does not match this deployment's ORIHOST_SYNC_SECRET. Instant sync for user ${userId} was REJECTED; the 10s daemon tick still applies it.`)
            } else {
              console.error(`[presence-sync] ${base}/sync → HTTP ${res.status} for user ${userId}`)
            }
            return false
          }
          // Best-effort parse of { ok, applied, queued } — older daemons
          // without the applied field just yield undefined (treated as
          // "dispatched, confirmation pending").
          try {
            const body = (await res.json()) as { applied?: boolean }
            return body
          } catch {
            return true
          }
        })
        .catch((err) => {
          hardFailures++
          console.error(`[presence-sync] ${base}/sync unreachable for user ${userId}: ${err instanceof Error ? err.message : err} — the daemon's tick will self-heal; check the node at ${base}/status if this persists.`)
          return false
        })

    const dispatched = Promise.all(bases.map(dispatch))

    // Connection confirmation window — resolve early when EVERY node hard-
    // failed (ECONNREFUSED / DNS); otherwise after CONFIRM_WINDOW_MS report
    // optimistically and let the pushes finish in the background (the daemon
    // completes each sync server-side even if this client stops waiting).
    const CONFIRM_WINDOW_MS = 1500
    return await new Promise<{ dispatched: boolean; applied?: boolean }>((resolve) => {
      const t = setTimeout(() => resolve({ dispatched: hardFailures < bases.length }), CONFIRM_WINDOW_MS)
      dispatched.then(
        (results) => {
          clearTimeout(t)
          const flags = results.filter((r): r is boolean | { applied?: boolean } => r !== false)
          const appliedFlags = flags
            .map((r) => (typeof r === 'object' && r !== null ? (r as { applied?: boolean }).applied : undefined))
            .filter((a): a is boolean => a === true)
          resolve({
            dispatched: flags.length > 0,
            // true only if at least one owning node CONFIRMED the apply;
            // undefined when confirmations are still in flight.
            applied: appliedFlags.length > 0 ? true : (flags.length > 0 ? undefined : false),
          })
        },
        () => { clearTimeout(t); resolve({ dispatched: false }) }
      )
    })
  } catch {
    return { dispatched: false }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Push the user's CURRENT DB state to Discord right now.
 *
 * Production (ORIHOST_DAEMON_URL set): notify the 24/7 daemon. On notify
 * failure we do NOT fall back to an in-process gateway push — that would
 * create a competing session (the flapping bug). The daemon's own 30s tick
 * self-heals any missed notification.
 *
 * Local dev (no ORIHOST_DAEMON_URL): classic in-process daemon syncUser.
 */
export async function syncPresence(userId: string): Promise<PresenceResult> {
  if (orihostDaemonConfigured()) {
    const ok = await notifyOrihostSync(userId, 'sync')
    return {
      ok,
      method: ok ? 'gateway' : 'none',
      message: ok
        ? 'Presence synced instantly via 24/7 daemon'
        : '24/7 daemon sync failed — the daemon retries automatically until applied',
    }
  }
  const daemon = ensureDaemonRunning()
  return daemon.syncUser(userId)
}

/**
 * Task 99 — like syncPresence, but ALSO returns whether the owning node
 * CONFIRMED the apply (running state verified against the saved config).
 * `applied: undefined` = the daemon is still applying (re-identify handshake
 * in flight) and its verify-retry chain will land it automatically.
 */
export async function syncPresenceVerified(userId: string): Promise<PresenceResult & { applied?: boolean }> {
  if (orihostDaemonConfigured()) {
    const result = await notifyOrihostSyncDetailed(userId, 'sync')
    return {
      ok: result.dispatched,
      method: result.dispatched ? 'gateway' : 'none',
      applied: result.applied,
      message: !result.dispatched
        ? '24/7 daemon unreachable — the daemon retry chain and 10s tick will apply the change automatically'
        : result.applied === true
          ? 'Applied & verified — Discord now shows the saved configuration'
          : 'Applying now — the daemon verifies and retries automatically until Discord confirms',
    }
  }
  const daemon = ensureDaemonRunning()
  const local = await daemon.syncUser(userId)
  return { ...local, applied: (local as { applied?: boolean }).applied }
}

/**
 * Stop/clear the user's RPC presence (toggle-off paths).
 * Same backend selection rules as syncPresence.
 */
export async function stopPresence(userId: string): Promise<PresenceResult> {
  if (orihostDaemonConfigured()) {
    const ok = await notifyOrihostSync(userId, 'stop')
    return {
      ok,
      method: ok ? 'gateway' : 'none',
      message: ok
        ? 'Presence cleared instantly via 24/7 daemon'
        : '24/7 daemon stop failed — daemon tick will reconcile within 30s',
    }
  }
  const daemon = ensureDaemonRunning()
  await daemon.stopUserRpc(userId)
  return {
    ok: true,
    method: 'gateway',
    message: 'Presence cleared via in-process daemon',
  }
}

/**
 * Fire-and-forget variant for paths that must never block the response
 * longer than necessary. Errors are logged, never thrown.
 */
export function syncPresenceDetached(userId: string, mode: SyncMode = 'sync'): void {
  const run = mode === 'stop' ? stopPresence(userId) : syncPresence(userId)
  run.catch(err => {
    console.error(`[10X RPC] Detached presence sync failed for user ${userId}:`, err)
  })
}

/** Health/telemetry helper for status endpoints. */
export function presenceBackend(): 'orihost-daemon' | 'in-process' {
  return orihostDaemonConfigured() ? 'orihost-daemon' : 'in-process'
}

// Keep getRpcDaemon referenced so tree-shaking never drops the module that
// owns the shared singleton in local-dev mode.
void getRpcDaemon
