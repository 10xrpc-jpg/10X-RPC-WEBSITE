// 10X RPC — Orihost / Pterodactyl 24/7 Backend Server Entrypoint (supervisor)
//
// 24/7 hardening:
// - The RPC daemon child is monitored via a heartbeat file (.daemon-heartbeat,
//   rewritten by the child every 30s). If the heartbeat goes stale — child hung,
//   event-loop blocked, zombie sockets — the supervisor KILLS it and the normal
//   exit path restarts it. A hung daemon can no longer sit invisible behind an
//   "ok" /health response.
// - Child spawn failures (npx missing / registry hiccup) now ALSO schedule a
//   restart instead of leaving the server daemon-less forever.
// - Restarts use exponential backoff (5s → 10s → 20s → 30s cap) and reset after
//   a stable period, but ALWAYS keep restarting — 24/7 mandate.
// - /health reports daemon heartbeat age; /status serves the full daemon status.
require('dotenv').config()
const { spawn, execSync } = require('child_process')
const http = require('http')
const fs = require('fs')
const path = require('path')

const PORT = process.env.SERVER_PORT || process.env.PORT || 3000
const HEARTBEAT_FILE = path.join(__dirname, '.daemon-heartbeat')
const HEARTBEAT_MAX_AGE_SEC = parseInt(process.env.DAEMON_HEARTBEAT_MAX_AGE_SEC || '180', 10)
const WATCHDOG_KILL_AFTER_SEC = parseInt(process.env.DAEMON_WATCHDOG_KILL_AFTER_SEC || '300', 10)

console.log('==============================================')
console.log('   🚀 10X RPC 24/7 Gateway Backend Server     ')
console.log('==============================================')

// ---------- heartbeat helpers ----------
function readHeartbeat() {
  try {
    const raw = fs.readFileSync(HEARTBEAT_FILE, 'utf8')
    const data = JSON.parse(raw)
    const ageSec = Math.max(0, Math.floor((Date.now() - Number(data.ts || 0)) / 1000))
    return { data, ageSec }
  } catch {
    return null
  }
}

// ---------- HTTP health/status server for Pterodactyl / Orihost monitoring ----------
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    const hb = readHeartbeat()
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    })
    res.end(JSON.stringify({
      status: 'ok',
      service: '10x-rpc-gateway-daemon',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      daemon: hb
        ? { heartbeatAgeSec: hb.ageSec, connected: hb.data.status?.activeConnections, trackedUsers: hb.data.status?.totalTrackedUsers, pid: hb.data.pid }
        : { heartbeatAgeSec: null, connected: null, trackedUsers: null, pid: null },
    }))
  } else if (req.url === '/status') {
    const hb = readHeartbeat()
    if (hb) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      })
      res.end(JSON.stringify({ heartbeatAgeSec: hb.ageSec, daemon: hb.data }))
    } else {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ error: 'no_daemon_heartbeat' }))
    }
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not_found' }))
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[10X RPC Server] HTTP Health check listening on 0.0.0.0:${PORT}`)
})

// ---------- Ensure Prisma Client is generated ----------
console.log('[10X RPC Server] Initializing Prisma ORM...')
try {
  execSync('npx prisma generate', { stdio: 'inherit' })
  console.log('[10X RPC Server] Prisma Client ready.')
} catch (err) {
  console.warn('[10X RPC Server] Prisma generate warning:', err.message)
}

// ---------- Spawn the standalone 24/7 RPC daemon (with supervisor logic) ----------
console.log('[10X RPC Server] Launching 24/7 Discord RPC & Status Daemon...')

let activeDaemon = null
let restartTimer = null
let lastDaemonStartAt = 0
let fastExitCount = 0
let lastSeenHeartbeatAt = Date.now() // generous boot window before the watchdog kicks in

function startDaemon() {
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  lastDaemonStartAt = Date.now()

  const daemon = spawn('npx', ['tsx', 'scripts/rpc-daemon-standalone.ts'], {
    stdio: 'inherit',
    env: process.env,
    cwd: __dirname,
  })
  activeDaemon = daemon

  // Guarded restart — never double-spawn, never give up.
  let restartScheduled = false
  const scheduleRestart = (delayMs, reason) => {
    if (restartScheduled) return
    restartScheduled = true
    if (activeDaemon === daemon) activeDaemon = null
    const livedSec = Math.floor((Date.now() - lastDaemonStartAt) / 1000)
    if (livedSec > 300) fastExitCount = 0 // stable run → reset backoff
    fastExitCount++
    const delay = Math.min(30000, delayMs * Math.pow(2, Math.max(0, fastExitCount - 1)))
    console.error(`[10X RPC Server] Daemon ${reason} (lived ${livedSec}s). Restarting in ${Math.round(delay / 1000)}s...`)
    restartTimer = setTimeout(startDaemon, delay)
  }

  daemon.on('close', (code) => {
    scheduleRestart(5000, `exited with code ${code}`)
  })

  daemon.on('error', (err) => {
    // Spawn failures (ENOENT, etc.) do NOT always fire 'close' — restart here too.
    console.error('[10X RPC Server] Daemon failed to start:', err.message)
    scheduleRestart(10000, 'failed to spawn')
  })

  return daemon
}

// Boot the daemon child (module-level activeDaemon tracks the current child)
startDaemon()

// ---------- Supervisor watchdog: kill a HUNG daemon (stale heartbeat) ----------
setInterval(() => {
  const hb = readHeartbeat()
  if (hb && hb.ageSec <= HEARTBEAT_MAX_AGE_SEC) {
    lastSeenHeartbeatAt = Date.now()
    return
  }
  const sinceSeenSec = Math.floor((Date.now() - lastSeenHeartbeatAt) / 1000)
  if (sinceSeenSec > WATCHDOG_KILL_AFTER_SEC) {
    console.error(`[10X RPC Server] Supervisor: daemon heartbeat stale for ${sinceSeenSec}s (no fresh heartbeat). Killing hung daemon for restart...`)
    lastSeenHeartbeatAt = Date.now() // reset window; close handler will restart the child
    try {
      if (activeDaemon && activeDaemon.exitCode === null) activeDaemon.kill('SIGKILL')
    } catch (err) {
      console.error('[10X RPC Server] Supervisor kill failed:', err.message)
    }
  }
}, 60000)

// ---------- Graceful shutdown handling ----------
process.on('SIGINT', () => {
  console.log('[10X RPC Server] Received SIGINT. Shutting down...')
  server.close()
  if (activeDaemon) activeDaemon.kill('SIGINT')
  process.exit(0)
})

process.on('SIGTERM', () => {
  console.log('[10X RPC Server] Received SIGTERM. Shutting down...')
  server.close()
  if (activeDaemon) activeDaemon.kill('SIGTERM')
  process.exit(0)
})
