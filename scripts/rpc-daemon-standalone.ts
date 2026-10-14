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
//
// SLOW-UPDATE FIX (instant sync):
// - A loopback-only HTTP server (127.0.0.1:DAEMON_SYNC_PORT, default 3100)
//   lets the supervisor proxy "sync user NOW" requests from the website:
//     POST /sync  {"userId": "...", "mode": "sync" | "stop"}
//     GET  /health
//   Saves/toggles on the website hit index.js /sync → this server →
//   daemon.syncUser() — presence updates in <1s instead of waiting for the
//   next 30s tick. Requests require the shared DAEMON_SYNC_SECRET (the
//   supervisor enforces it for external callers; this listener is additionally
//   bound to loopback so only the supervisor can reach it directly).
// - Per-user rate limiting (1.5s) with trailing re-sync keeps bursts of UI
//   actions from tripping Discord's presence rate limits.

import fs from 'fs'
import http from 'http'
import path from 'path'
import { getRpcDaemon } from '../src/lib/rpc-daemon'
import { getApplicationRpcDaemon } from '../src/lib/application-rpc-daemon'

const HEARTBEAT_FILE = path.join(process.cwd(), '.daemon-heartbeat')
const SYNC_PORT = parseInt(process.env.DAEMON_SYNC_PORT || '3100', 10)
const SYNC_SECRET = process.env.DAEMON_SYNC_SECRET || ''
const SYNC_MIN_INTERVAL_MS = 1500

function writeHeartbeat(): void {
  try {
    const daemon = getRpcDaemon()
    const payload = {
      ts: Date.now(),
      iso: new Date().toISOString(),
      pid: process.pid,
      status: daemon.getStatus(),
      application: getApplicationRpcDaemon().getStatus(),
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

// ─── Instant-sync loopback server ───────────────────────────────────────────
const lastSyncAt = new Map<string, number>()
const trailingSync = new Map<string, NodeJS.Timeout>()

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 64 * 1024) req.destroy() // abuse guard
    })
    req.on('end', () => resolve(body))
    req.on('error', () => resolve(body))
  })
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) return
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(JSON.stringify(payload))
}

async function runSync(userId: string, mode: string): Promise<{ ok: boolean; message: string }> {
  try {
    if (mode === 'stop') {
      await daemon.stopUserRpc(userId)
      // Application RPC is INDEPENDENT: a Normal/Game 'stop' notification must
      // never stop it — syncUser re-evaluates ONLY the Application RPC's own
      // enabled flag (kept running when its own row is enabled).
      await getApplicationRpcDaemon().syncUser(userId)
      return { ok: true, message: 'Presence stopped via instant sync' }
    }
    const result = await daemon.syncUser(userId)
    const appResult = await getApplicationRpcDaemon().syncUser(userId)
    const ok = !!result?.ok && appResult.ok
    const message = result?.message || appResult.message || 'Presence synced via instant sync'
    return { ok, message }
  } catch (err) {
    return {
      ok: false,
      message: `Sync failed: ${err instanceof Error ? err.message : 'unknown error'}`,
    }
  }
}

async function handleSync(userId: string, mode: string): Promise<{ ok: boolean; queued: boolean; message: string }> {
  const now = Date.now()
  const last = lastSyncAt.get(userId) ?? 0
  const waitMs = SYNC_MIN_INTERVAL_MS - (now - last)
  if (waitMs > 0) {
    // Inside the cooldown — schedule ONE trailing re-sync so the latest state
    // always lands, and report as queued (idempotent for the caller).
    if (!trailingSync.has(userId)) {
      const timer = setTimeout(() => {
        trailingSync.delete(userId)
        lastSyncAt.set(userId, Date.now())
        runSync(userId, mode).catch(() => {})
      }, waitMs + 25)
      trailingSync.set(userId, timer)
    }
    return { ok: true, queued: true, message: 'Sync queued (rate limit cooldown)' }
  }
  lastSyncAt.set(userId, now)
  const result = await runSync(userId, mode)
  return { ...result, queued: false }
}

const syncServer = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const route = url.pathname

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-sync-secret',
    })
    res.end()
    return
  }

  // Secret check — shared with the supervisor proxy and the website.
  if (SYNC_SECRET) {
    const provided = req.headers['x-sync-secret'] || url.searchParams.get('secret') || ''
    if (provided !== SYNC_SECRET) {
      sendJson(res, 403, { ok: false, error: 'invalid_secret' })
      return
    }
  }

  if (route === '/sync' && req.method === 'POST') {
    readBody(req).then((raw) => {
      let userId = ''
      let mode = 'sync'
      try {
        const parsed = JSON.parse(raw || '{}')
        userId = typeof parsed.userId === 'string' ? parsed.userId : ''
        mode = parsed.mode === 'stop' ? 'stop' : 'sync'
      } catch {
        // fallthrough with empty userId
      }
      if (!userId) {
        sendJson(res, 400, { ok: false, error: 'userId_required' })
        return
      }
      handleSync(userId, mode)
        .then((result) => sendJson(res, 200, result))
        .catch((err) => sendJson(res, 500, { ok: false, error: err?.message || 'sync_failed' }))
    })
    return
  }

  if ((route === '/health' || route === '/') && req.method === 'GET') {
    sendJson(res, 200, {
      status: 'ok',
      service: '10x-rpc-standalone-daemon',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      daemon: daemon.getStatus(),
      application: getApplicationRpcDaemon().getStatus(),
    })
    return
  }

  sendJson(res, 404, { ok: false, error: 'not_found' })
})

try {
  syncServer.listen(SYNC_PORT, '127.0.0.1', () => {
    console.log(`[10X RPC Standalone Daemon] Instant-sync server listening on 127.0.0.1:${SYNC_PORT}`)
  })
} catch (err) {
  console.error('[10X RPC Standalone Daemon] Sync server listen failed (daemon keeps running):', err)
}

daemon.start().then(() => {
  console.log('[10X RPC Standalone Daemon] Running 24/7. Press Ctrl+C to stop.')
  writeHeartbeat()
}).catch(err => {
  console.error('[10X RPC Standalone Daemon] Fatal error on startup:', err)
  process.exit(1)
})

// Task 90 — the Application RPC daemon runs INDEPENDENTLY alongside the main
// daemon: own tick, own sessions, own config table. A failure here never
// affects the Normal/Game presence loop (and vice versa).
getApplicationRpcDaemon().start().catch(err => {
  console.error('[10X RPC Standalone Daemon] Application RPC daemon failed to start (main daemon unaffected):', err)
})

process.on('SIGINT', () => {
  console.log('[10X RPC Standalone Daemon] SIGINT received, stopping daemon...')
  daemon.stop()
  getApplicationRpcDaemon().stop()
  process.exit(0)
})

process.on('SIGTERM', () => {
  console.log('[10X RPC Standalone Daemon] SIGTERM received, stopping daemon...')
  daemon.stop()
  getApplicationRpcDaemon().stop()
  process.exit(0)
})
