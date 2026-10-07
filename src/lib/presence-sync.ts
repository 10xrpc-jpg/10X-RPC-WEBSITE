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

export function orihostDaemonConfigured(): boolean {
  return !!process.env.ORIHOST_DAEMON_URL
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
  const base = process.env.ORIHOST_DAEMON_URL
  if (!base) return false
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const dispatched = fetch(`${base.replace(/\/+$/, '')}/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.ORIHOST_SYNC_SECRET
          ? { 'x-sync-secret': process.env.ORIHOST_SYNC_SECRET }
          : {}),
      },
      body: JSON.stringify({ userId, mode }),
      signal: controller.signal,
    })
      .then(res => res.ok)
      .catch(() => false)

    // Connection confirmation window — resolve early on hard failure
    // (ECONNREFUSED / DNS) and otherwise after CONFIRM_WINDOW_MS.
    const CONFIRM_WINDOW_MS = 1500
    return await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(true), CONFIRM_WINDOW_MS)
      dispatched.then(
        ok => { clearTimeout(t); resolve(ok) },
        () => { clearTimeout(t); resolve(false) }
      )
    })
  } catch {
    return false
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
        : '24/7 daemon sync failed — daemon tick will retry within 30s',
    }
  }
  const daemon = ensureDaemonRunning()
  return daemon.syncUser(userId)
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
