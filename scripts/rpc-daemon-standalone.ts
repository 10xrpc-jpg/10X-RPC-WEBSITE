// Standalone Runner for 10X RPC 24/7 Daemon
// Runs under the Orihost/Pterodactyl supervisor (index.js) as a dedicated
// background process. Command: npx tsx scripts/rpc-daemon-standalone.ts
//
// 24/7 hardening:
// - Process-level handlers: unhandled rejections / uncaught exceptions are
//   LOGGED but NEVER kill the process (presence uptime is the top priority;
//   the internal watchdog repairs whatever state caused the error).
// - Heartbeat file (.daemon-heartbeat) rewritten every 30s so the supervisor
//   (index.js) can detect a HUNG daemon (not exited, but stalled) and restart it.

import fs from 'fs'
import path from 'path'
import { getRpcDaemon } from '../src/lib/rpc-daemon'

const HEARTBEAT_FILE = path.join(process.cwd(), '.daemon-heartbeat')

function writeHeartbeat(): void {
  try {
    const daemon = getRpcDaemon()
    const payload = {
      ts: Date.now(),
      iso: new Date().toISOString(),
      pid: process.pid,
      status: daemon.getStatus(),
    }
    fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify(payload))
  } catch (err) {
    console.error('[10X RPC Standalone Daemon] Heartbeat write failed:', err)
  }
}

// Never die from stray async errors — log and keep the presence alive.
process.on('unhandledRejection', (reason) => {
  console.error('[10X RPC Standalone Daemon] Unhandled rejection (daemon stays alive):', reason)
})

process.on('uncaughtException', (err) => {
  console.error('[10X RPC Standalone Daemon] Uncaught exception (daemon stays alive):', err)
})

console.log('[10X RPC Standalone Daemon] Booting standalone background daemon process...')

const daemon = getRpcDaemon()
writeHeartbeat()
setInterval(writeHeartbeat, 30000)

daemon.start().then(() => {
  console.log('[10X RPC Standalone Daemon] Running 24/7. Press Ctrl+C to stop.')
  writeHeartbeat()
}).catch(err => {
  console.error('[10X RPC Standalone Daemon] Fatal error on startup:', err)
  process.exit(1)
})

process.on('SIGINT', () => {
  console.log('[10X RPC Standalone Daemon] SIGINT received, stopping daemon...')
  daemon.stop()
  process.exit(0)
})

process.on('SIGTERM', () => {
  console.log('[10X RPC Standalone Daemon] SIGTERM received, stopping daemon...')
  daemon.stop()
  process.exit(0)
})
