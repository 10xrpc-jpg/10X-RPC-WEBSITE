// Next.js Server Lifecycle Hook — Instrumentation
// Automatically starts the 24/7 Discord RPC & Status Daemon on server boot.

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
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
