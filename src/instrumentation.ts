// Next.js Server Lifecycle Hook — Instrumentation
// Starts the local 24/7 Discord RPC & Status Daemon on server boot — but ONLY
// when this deployment owns presence locally (no remote 24/7 daemon configured).
//
// SLOW-UPDATE FIX: with ORIHOST_DAEMON_URL set (production), the Orihost daemon
// is the SINGLE presence owner. Starting an in-process gateway session here
// created a second competing Discord session (stale overwrites / flapping
// profile). Save paths push updates to the remote daemon via /sync instead
// (see src/lib/presence-sync.ts).

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    if (process.env.ORIHOST_DAEMON_URL) {
      console.log('[Instrumentation] ORIHOST_DAEMON_URL set — presence owned by remote 24/7 daemon, skipping local daemon.')
      return
    }
    try {
      const { getRpcDaemon } = await import('@/lib/rpc-daemon')
      getRpcDaemon().start().catch((err: unknown) => {
        console.error('[Instrumentation] Failed to start 10X RPC Daemon:', err)
      })
    } catch (err) {
      console.error('[Instrumentation] Error importing rpc-daemon:', err)
    }
  }
}
