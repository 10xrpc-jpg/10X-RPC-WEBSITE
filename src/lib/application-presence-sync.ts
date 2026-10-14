// 10X RPC — Application RPC presence-sync entrypoint (Task 90).
//
// Mirrors presence-sync.ts but routes ONLY the Application RPC's own
// notifications — it never invokes the Normal/Game daemon's syncUser/stop.
//
// Production (ORIHOST_DAEMON_URL set): notify the 24/7 daemon's /sync.
// The standalone runner applies that notification to BOTH daemons, and each
// daemon obeys ONLY its own configuration — so this call refreshes the
// Application RPC and can never start/stop the Normal or Game systems.
//
// Local dev (no ORIHOST_DAEMON_URL): sync the in-process Application daemon.

import { ensureApplicationDaemonRunning } from '@/lib/application-rpc-daemon'
import { notifyOrihostSync, orihostDaemonConfigured } from '@/lib/presence-sync'

export interface ApplicationSyncResult {
  ok: boolean
  message: string
}

export async function syncApplicationPresence(userId: string): Promise<ApplicationSyncResult> {
  if (orihostDaemonConfigured()) {
    const ok = await notifyOrihostSync(userId, 'sync')
    return {
      ok,
      message: ok
        ? 'Application RPC synced instantly via 24/7 daemon'
        : '24/7 daemon sync failed — the daemon tick will retry within 10s',
    }
  }
  const daemon = ensureApplicationDaemonRunning()
  const res = await daemon.syncUser(userId)
  return { ok: res.ok, message: res.message }
}

/** Fire-and-forget variant for paths that must never block the response. */
export function syncApplicationPresenceDetached(userId: string): void {
  syncApplicationPresence(userId).catch(err => {
    console.error(`[10X RPC] Detached Application RPC sync failed for user ${userId}:`, err)
  })
}

// Keep the daemon module referenced so tree-shaking never drops the module
// that owns the shared singleton in local-dev mode.
void ensureApplicationDaemonRunning
