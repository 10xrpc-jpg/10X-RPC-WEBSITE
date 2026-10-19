// 10X RPC — Orihost / Pterodactyl 24/7 Backend Server Entrypoint (supervisor)
//
// 24/7 hardening:
// - EVERY daemon child (the node's own pillar + any ADOPTED pillar) is
//   monitored via a heartbeat file (rewritten by the child every 30s). If a
//   heartbeat goes stale — child hung, event-loop blocked, zombie sockets —
//   the supervisor KILLS it and the normal exit path restarts it. A hung
//   daemon can no longer sit invisible behind an "ok" /health response.
// - Child spawn failures (npx missing / registry hiccup) now ALSO schedule a
//   restart instead of leaving the server daemon-less forever.
// - Restarts use exponential backoff (5s → 10s → 20s → 30s cap) and reset after
//   a stable period, but ALWAYS keep restarting — 24/7 mandate.
// - /health reports daemon heartbeat age; /status serves the full daemon status.
//
// ─── PILLAR FAILOVER (Task 118 — "VR/status dies when its node dies" fix) ───
// The three Orihost nodes split the product into pillars by DAEMON_ROLE:
//   NODE 1 = STATUS (custom status, VR badge), NODE 2 = RPC, NODE 3 = GAME.
// Historically a dead node killed its ENTIRE pillar for every user until a
// human restarted the panel server. Now every supervisor writes a lease row
// (shared Postgres, table "DaemonNodeLease") every 15s naming the pillars it
// covers. When a pillar's owner stops renewing (node down >75s), the DESIGNATED
// survivor (lowest nodeId among fresh leases) spawns a failover daemon child
// for that pillar on a secondary loopback port — VR/status keeps running on
// the surviving hardware. When the original owner's lease goes fresh again the
// adopter kills its failover child and the pillar goes home. Node-local
// crashes/hangs keep the existing heartbeat-watchdog repair path.
// Fail-safe: if the DB is unreachable, adoption decisions are SKIPPED (no
// spawning, no killing) — the pre-failover behavior is preserved exactly.
// ---- boot-stage file logger (survives container death; readable via panel API) ----
// MUST run before ANY external require() so even a failed dotenv/prisma import
// is captured. Tees ALL supervisor console output into boot-log.txt.
const fs = require('fs')
const path = require('path')
const os = require('os')
const BOOT_LOG = path.join(__dirname, 'boot-log.txt')
try { fs.writeFileSync(BOOT_LOG, `=== boot ${new Date().toISOString()} pid=${process.pid} node=${process.version} argv=${JSON.stringify(process.argv)}\n`) } catch {}
function blog(msg) {
  try {
    // Rotate at 2MB (keep one previous generation) so the tee never fills the disk.
    try {
      const st = fs.statSync(BOOT_LOG)
      if (st.size > 2 * 1024 * 1024) fs.renameSync(BOOT_LOG, `${BOOT_LOG}.1`)
    } catch {}
    fs.appendFileSync(BOOT_LOG, `${new Date().toISOString()} ${msg}\n`)
  } catch {}
}
process.on('uncaughtException', (err) => {
  blog(`UNCAUGHT-EXCEPTION ${err && err.stack ? String(err.stack).slice(0, 800) : String(err)}`)
})
process.on('unhandledRejection', (reason) => {
  blog(`UNHANDLED-REJECTION ${String(reason).slice(0, 500)}`)
})
process.on('exit', (code) => {
  blog(`=== node exit code=${code}`)
})
blog('node is alive')

for (const level of ['log', 'error', 'warn', 'info']) {
  const orig = console[level].bind(console)
  console[level] = (...args) => {
    try {
      const line = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a) || String(a))).join(' ')
      fs.appendFileSync(BOOT_LOG, `${new Date().toISOString()} ${line}\n`)
    } catch {}
    orig(...args)
  }
}

require('dotenv').config()
blog('dotenv loaded')
const { spawn, execSync } = require('child_process')
const http = require('http')
const { PILLARS, computeFailoverDecisions } = require('./scripts/failover-decisions')
blog('requires done')

const PORT = process.env.SERVER_PORT || process.env.PORT || 3000
const HEARTBEAT_MAX_AGE_SEC = parseInt(process.env.DAEMON_HEARTBEAT_MAX_AGE_SEC || '180', 10)
const WATCHDOG_KILL_AFTER_SEC = parseInt(process.env.DAEMON_WATCHDOG_KILL_AFTER_SEC || '300', 10)

console.log('==============================================')
console.log('   🚀 10X RPC 24/7 Gateway Backend Server     ')
console.log('==============================================')

// ---------- sync proxy config ----------
// SLOW-UPDATE FIX: POST /sync proxies an instant "sync user NOW" request from
// the website to every daemon child's loopback sync server (127.0.0.1:port).
// Each child role-gates the sync to its own pillar, so broadcasting inside the
// node is safe. External callers must present the shared secret
// (x-sync-secret header or ?secret= query).
// SECRET-NAME ROBUSTNESS (Task 118): the website historically sent
// ORIHOST_SYNC_SECRET while the node expected DAEMON_SYNC_SECRET — a name
// mismatch silently 403'd every instant sync. Accept EITHER name on the node
// side (the site sends ORIHOST_SYNC_SECRET first, DAEMON_SYNC_SECRET fallback).
const SYNC_PORT = parseInt(process.env.DAEMON_SYNC_PORT || '3100', 10)
const SYNC_SECRET = process.env.DAEMON_SYNC_SECRET || process.env.ORIHOST_SYNC_SECRET || ''

// ---------- role helpers ----------
function normalizeRole(raw) {
  const r = String(raw || 'all').trim().toLowerCase()
  return r === 'status' || r === 'rpc' || r === 'game' ? r : 'all'
}
const BASE_ROLE = normalizeRole(process.env.DAEMON_ROLE)
/** Pillars this node covers by RIGHT (its own DAEMON_ROLE). */
const BASE_COVERAGE = BASE_ROLE === 'all' ? [...PILLARS] : [BASE_ROLE]
/** Deterministic loopback ports for failover children (base child keeps 3100). */
const FAILOVER_PORT = { status: 3101, rpc: 3102, game: 3103 }
const isSqlite = String(process.env.DATABASE_URL || '').startsWith('file:')

// ---------- multi-child manager ----------
// children: Map<role, record>. The BASE role child is started unconditionally
// at boot; failover children are spawned/released by the lease controller.
const children = new Map()

function childPort(role, isBase) {
  return isBase ? SYNC_PORT : FAILOVER_PORT[role] || 3104
}
function childHeartbeatFile(role, isBase) {
  return isBase
    ? path.join(__dirname, '.daemon-heartbeat')
    : path.join(__dirname, `.daemon-heartbeat.${role}`)
}

function readHeartbeat(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const data = JSON.parse(raw)
    const ageSec = Math.max(0, Math.floor((Date.now() - Number(data.ts || 0)) / 1000))
    return { data, ageSec }
  } catch {
    return null
  }
}

function startChild(role, isBase) {
  const existing = children.get(role)
  if (existing && existing.proc && existing.proc.exitCode === null) return existing
  if (existing && existing.restartTimer) {
    clearTimeout(existing.restartTimer)
    existing.restartTimer = null
  }

  const rec = existing || {
    role,
    isBase,
    proc: null,
    port: childPort(role, isBase),
    heartbeatFile: childHeartbeatFile(role, isBase),
    restartTimer: null,
    restartScheduled: false,
    fastExitCount: 0,
    lastStartAt: 0,
    lastSeenHeartbeatAt: Date.now(), // generous boot window before the watchdog kicks in
    intentionalStop: false,
  }
  rec.isBase = isBase
  rec.intentionalStop = false
  rec.lastStartAt = Date.now()
  rec.restartScheduled = false
  blog(`stage: spawn-child role=${role} base=${isBase} port=${rec.port}`)

  // ════════════════════════════════════════════════════════════════════
  // 24/7 DB-STABILITY FIX (unchanged): the daemon is a LONG-LIVED process
  // holding DB connections for days. Neon's POOLED endpoint aggressively
  // recycles idle pooler connections → recurring "Can't reach database
  // server" bursts. Give every daemon child the DIRECT (unpooled) endpoint
  // when available.
  // ════════════════════════════════════════════════════════════════════
  const childEnv = { ...process.env }
  childEnv.DAEMON_ROLE = role
  childEnv.DAEMON_SYNC_PORT = String(rec.port)
  childEnv.DAEMON_HEARTBEAT_FILE = rec.heartbeatFile
  if (childEnv.DATABASE_URL_UNPOOLED) {
    childEnv.DATABASE_URL = childEnv.DATABASE_URL_UNPOOLED
    blog(`stage: child-db=unpooled role=${role} (direct endpoint for long-lived connections)`)
  }

  const daemon = spawn('npx', ['tsx', 'scripts/rpc-daemon-standalone.ts'], {
    // Pipe (not inherit) so child crashes are ALSO captured in boot-log.txt —
    // the wings console isn't reachable via the client API, and a 2s-lifetime
    // crash-loop with invisible stderr is undiagnosable.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv,
    cwd: __dirname,
  })
  daemon.stdout.on('data', (d) => process.stdout.write(d))
  daemon.stderr.on('data', (d) => {
    const line = String(d).trim()
    if (line) blog(`[child-${role}-stderr] ${line.slice(0, 800)}`)
    process.stderr.write(d)
  })
  rec.proc = daemon
  blog(`stage: child-spawned role=${role} pid=${daemon.pid}`)
  console.log(`[10X RPC Server] Daemon child role=${role}${isBase ? ' (base)' : ' (ADOPTED failover)'} pid=${daemon.pid} sync-port=${rec.port}`)

  // Guarded restart — never double-spawn, never give up.
  const scheduleRestart = (delayMs, reason) => {
    if (rec.restartScheduled) return
    rec.restartScheduled = true
    if (rec.intentionalStop) return // released by failover — do NOT resurrect
    if (children.get(role) === rec) rec.proc = null
    const livedSec = Math.floor((Date.now() - rec.lastStartAt) / 1000)
    if (livedSec > 300) rec.fastExitCount = 0 // stable run → reset backoff
    rec.fastExitCount++
    const delay = Math.min(30000, delayMs * Math.pow(2, Math.max(0, rec.fastExitCount - 1)))
    console.error(`[10X RPC Server] Daemon role=${role} ${reason} (lived ${livedSec}s). Restarting in ${Math.round(delay / 1000)}s...`)
    blog(`stage: child-${reason} role=${role} lived=${livedSec}s restart-in=${Math.round(delay / 1000)}s`)
    rec.restartTimer = setTimeout(() => startChild(role, isBase), delay)
  }

  daemon.on('close', (code) => {
    if (rec.intentionalStop) {
      blog(`stage: child-exited-cleanly role=${role} (intentional stop — failover released)`)
      return
    }
    scheduleRestart(5000, `exited with code ${code}`)
  })

  daemon.on('error', (err) => {
    // Spawn failures (ENOENT, etc.) do NOT always fire 'close' — restart here too.
    console.error(`[10X RPC Server] Daemon role=${role} failed to start:`, err.message)
    blog(`stage: child-spawn-error role=${role} err=${err.message}`)
    scheduleRestart(10000, 'failed to spawn')
  })

  children.set(role, rec)
  return rec
}

function stopChild(role, reason) {
  const rec = children.get(role)
  if (!rec) return
  rec.intentionalStop = true
  if (rec.restartTimer) {
    clearTimeout(rec.restartTimer)
    rec.restartTimer = null
  }
  try {
    if (rec.proc && rec.proc.exitCode === null) rec.proc.kill('SIGTERM')
  } catch (err) {
    blog(`stage: child-stop-error role=${role} err=${String(err.message).slice(0, 200)}`)
  }
  children.delete(role)
  blog(`stage: child-released role=${role} reason=${reason}`)
  console.log(`[10X RPC Server] Released adopted pillar role=${role} (${reason}) — owner is back.`)
}

// ---------- HTTP health/status server for Pterodactyl / Orihost monitoring ----------
function childSummaries() {
  const out = []
  for (const [role, rec] of children) {
    const hb = readHeartbeat(rec.heartbeatFile)
    out.push({
      role,
      isBase: rec.isBase,
      pid: rec.proc?.pid ?? null,
      heartbeatAgeSec: hb ? hb.ageSec : null,
      connected: hb?.data?.status?.activeConnections ?? null,
      trackedUsers: hb?.data?.status?.totalTrackedUsers ?? null,
      status: hb?.data?.status ?? null,
    })
  }
  return out
}

function proxyToChildSync(rec, req, res, providedSecret) {
  return new Promise((resolve) => {
    const options = {
      hostname: '127.0.0.1',
      port: rec.port,
      path: '/sync',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-sync-secret': providedSecret || SYNC_SECRET,
      },
      timeout: 8000,
    }
    const upstream = http.request(options, (up) => {
      let body = ''
      up.on('data', (d) => { body += d })
      up.on('end', () => resolve({ port: rec.port, role: rec.role, status: up.statusCode, body }))
      // If the client is still waiting we can stream; simplest honest merge is
      // to buffer the (tiny) child JSON then answer once.
    })
    upstream.on('timeout', () => upstream.destroy(new Error('sync upstream timeout')))
    upstream.on('error', (err) => resolve({ port: rec.port, role: rec.role, status: 502, body: JSON.stringify({ ok: false, error: 'daemon_sync_unreachable', message: err.message }) }))
    req.pipe(upstream)
  })
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-sync-secret',
    })
    res.end()
  } else if (req.url === '/health' || req.url === '/') {
    const baseRec = children.get(BASE_ROLE) || children.get(BASE_COVERAGE[0])
    const hb = baseRec ? readHeartbeat(baseRec.heartbeatFile) : null
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
      // Task 90 — additive Application RPC daemon status (independent system,
      // reported from the same heartbeat; null on pre-Task-90 heartbeats).
      application: hb?.data?.application ?? null,
      // Task 118 — multi-child visibility (additive; old parsers ignore it).
      role: BASE_ROLE,
      adopted: [...children.keys()].filter(r => !BASE_COVERAGE.includes(r) && r !== BASE_ROLE),
      children: childSummaries(),
    }))
  } else if (url.pathname === '/sync') {
    // Shared-secret gate for EXTERNAL callers (the website). The supervisor
    // itself talks to the children over loopback.
    const provided = req.headers['x-sync-secret'] || url.searchParams.get('secret') || ''
    if (SYNC_SECRET && provided !== SYNC_SECRET) {
      res.writeHead(403, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      })
      res.end(JSON.stringify({ ok: false, error: 'invalid_secret' }))
      return
    }
    if (!SYNC_SECRET) {
      // Refuse to run an OPEN sync endpoint on a public port.
      res.writeHead(503, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      })
      res.end(JSON.stringify({ ok: false, error: 'DAEMON_SYNC_SECRET_not_configured' }))
      return
    }
    // Task 118 — fan the sync out to EVERY child (base + adopted). Each child
    // role-gates internally, so a status child ignores rpc-only changes and
    // vice versa. Merge into the historic single-child response shape.
    const recs = [...children.values()]
    if (recs.length === 0) {
      res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ ok: false, error: 'no_daemon_children' }))
      return
    }
    // The body must be piped to N upstreams — clone it once.
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      const bodyBuf = Buffer.concat(chunks)
      const answers = await Promise.all(recs.map((rec) => new Promise((resolve) => {
        const upstream = http.request({
          hostname: '127.0.0.1',
          port: rec.port,
          path: '/sync',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-sync-secret': provided || SYNC_SECRET },
          timeout: 8000,
        }, (up) => {
          let b = ''
          up.on('data', (d) => { b += d })
          up.on('end', () => resolve({ role: rec.role, status: up.statusCode, body: b }))
        })
        upstream.on('timeout', () => upstream.destroy(new Error('sync upstream timeout')))
        upstream.on('error', (err) => resolve({ role: rec.role, status: 502, body: JSON.stringify({ ok: false, message: err.message }) }))
        upstream.end(bodyBuf)
      })))
      let ok = false // 200 when AT LEAST ONE child answered at transport level
      let applied // undefined = no owning child reported; true/false from owners
      let queued = false
      let message = 'Presence synced via instant sync'
      const results = []
      for (const a of answers) {
        let parsed = {}
        try { parsed = JSON.parse(a.body || '{}') } catch {}
        results.push({ role: a.role, status: a.status, ok: parsed.ok, applied: parsed.applied })
        // Transport-level success only: a child's ok:false with a message is a
        // LEGITIMATE answer ("nothing to apply yet" / verify chain armed), the
        // same shape the single-child proxy passed through verbatim. Only a
        // 502/timeout marks the node as unreachable.
        if (a.status === 200) ok = true
        if (parsed.applied === true) applied = true
        else if (parsed.applied === false && applied !== true) applied = false
        if (parsed.queued === true) queued = true
        if (parsed.ok === false && parsed.message) message = parsed.message
      }
      if (applied === undefined && ok) message = 'Presence synced (no owning pillar for this user on this node)'
      res.writeHead(ok ? 200 : 502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ ok, applied, queued, message, results }))
    })
  } else if (req.url === '/status') {
    const baseRec = children.get(BASE_ROLE) || children.get(BASE_COVERAGE[0])
    const hb = baseRec ? readHeartbeat(baseRec.heartbeatFile) : null
    if (hb) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      })
      // Top-level `daemon` stays the BASE child (backward compatible); the
      // adopted children are additive so uptime/status tooling can show them.
      res.end(JSON.stringify({
        heartbeatAgeSec: hb.ageSec,
        daemon: hb.data,
        role: BASE_ROLE,
        adopted: [...children.keys()].filter(r => !BASE_COVERAGE.includes(r) && r !== BASE_ROLE),
        children: childSummaries(),
        lease: leaseView(),
      }))
    } else {
      // Base child has no heartbeat yet — still report adopted children so a
      // node mid-restart never looks fully dead while carrying a pillar.
      const kids = childSummaries()
      if (kids.length > 0) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({
          heartbeatAgeSec: null,
          daemon: null,
          role: BASE_ROLE,
          adopted: [...children.keys()].filter(r => !BASE_COVERAGE.includes(r) && r !== BASE_ROLE),
          children: kids,
          lease: leaseView(),
        }))
      } else {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ error: 'no_daemon_heartbeat' }))
      }
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
blog('stage: prisma-generate-start')
try {
  execSync('npx prisma generate', { stdio: 'inherit' })
  console.log('[10X RPC Server] Prisma Client ready.')
  blog('stage: prisma-generate-ok')
} catch (err) {
  console.warn('[10X RPC Server] Prisma generate warning:', err.message)
  blog(`stage: prisma-generate-FAIL err=${String(err.message).slice(0, 300)}`)
}

// Boot the BASE daemon child (module-level map tracks every child)
startChild(BASE_ROLE, true)

// ─── PILLAR FAILOVER CONTROLLER (Task 118) ──────────────────────────────────
// Every supervisor periodically writes a lease row (nodeId → covered pillars)
// and reads everyone else's. A pillar whose owner went quiet (>75s) is adopted
// by the designated survivor (lowest nodeId among fresh leases). When the
// owner's lease goes fresh again the adopter releases the pillar.
const LEASE_BEAT_MS = 15_000
const LEASE_TTL_SEC = 75
const LEASE_TABLE = 'DaemonNodeLease'
const NODE_ID = `${os.hostname()}:${PORT}`
let leaseDb = null
let leaseReady = false
let lastAdoptedSummary = ''

function leaseView() {
  return {
    nodeId: NODE_ID,
    baseRole: BASE_ROLE,
    adopted: [...children.keys()].filter(r => !BASE_COVERAGE.includes(r) && r !== BASE_ROLE),
    db: leaseReady ? 'ok' : (isSqlite ? 'disabled-sqlite' : 'unavailable'),
  }
}

async function leaseEnsureTable(db) {
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "${LEASE_TABLE}" (
      "nodeId"    TEXT PRIMARY KEY,
      "baseRole"  TEXT NOT NULL,
      "roles"     TEXT NOT NULL,
      "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now()
    )`)
}

async function leaseBeat() {
  if (!leaseDb) return
  const adopted = [...children.keys()].filter(r => !BASE_COVERAGE.includes(r) && r !== BASE_ROLE)
  const myRoles = [...BASE_COVERAGE, ...adopted]
  const rolesJson = JSON.stringify(myRoles)
  try {
    await leaseDb.$executeRawUnsafe(
      `INSERT INTO "${LEASE_TABLE}" ("nodeId","baseRole","roles","updatedAt")
       VALUES ($1, $2, $3, now())
       ON CONFLICT ("nodeId") DO UPDATE
       SET "baseRole" = $2, "roles" = $3, "updatedAt" = now()`,
      NODE_ID, BASE_ROLE, rolesJson,
    )
    leaseReady = true
  } catch (err) {
    // 42P01 = table missing (first boot after deploy) → create and retry once.
    if (String(err?.code) === '42P01') {
      try {
        await leaseEnsureTable(leaseDb)
        await leaseDb.$executeRawUnsafe(
          `INSERT INTO "${LEASE_TABLE}" ("nodeId","baseRole","roles","updatedAt")
           VALUES ($1, $2, $3, now())
           ON CONFLICT ("nodeId") DO UPDATE
           SET "baseRole" = $2, "roles" = $3, "updatedAt" = now()`,
          NODE_ID, BASE_ROLE, rolesJson,
        )
        leaseReady = true
        blog('stage: lease-table-created')
      } catch (err2) {
        blog(`lease-write-FAIL err=${String(err2?.message || err2).slice(0, 200)}`)
        return
      }
    } else {
      blog(`lease-write-FAIL err=${String(err?.message || err).slice(0, 200)}`)
      return // DB unreachable → make NO failover decisions this beat
    }
  }

  let rows
  try {
    const cutoff = new Date(Date.now() - LEASE_TTL_SEC * 1000)
    rows = await leaseDb.$queryRawUnsafe(
      `SELECT "nodeId", "baseRole", "roles", "updatedAt"
       FROM "${LEASE_TABLE}" WHERE "updatedAt" > $1`,
      cutoff,
    )
  } catch (err) {
    blog(`lease-read-FAIL err=${String(err?.message || err).slice(0, 200)}`)
    return // unknown world → touch nothing
  }

  // Fresh leases (including mine). nodeId strings sort deterministically.
  const fresh = (rows || []).map(r => ({
    nodeId: String(r.nodeId),
    baseRole: String(r.baseRole || ''),
    roles: (() => { try { return JSON.parse(String(r.roles || '[]')) } catch { return [] } })(),
  }))

  // Pure decision core (scripts/failover-decisions.js) — adopt orphaned
  // pillars when designated, release them when the owner returns.
  const decisions = computeFailoverDecisions({
    myNodeId: NODE_ID,
    baseCoverage: BASE_COVERAGE,
    runningChildRoles: [...children.keys()],
    freshLeases: fresh,
  })

  for (const pillar of decisions.adopt) {
    console.warn(`[10X RPC Server] FAILOVER: pillar "${pillar}" has NO live owner — adopting it (designated survivor ${NODE_ID}).`)
    blog(`FAILOVER-ADOPT pillar=${pillar} by=${NODE_ID} freshLeases=${fresh.map(f => f.nodeId).join('|')}`)
    startChild(pillar, false)
  }
  for (const pillar of decisions.release) {
    console.log(`[10X RPC Server] FAILOVER: pillar "${pillar}" owner is back — releasing it.`)
    blog(`FAILOVER-RELEASE pillar=${pillar} by=${NODE_ID}`)
    stopChild(pillar, 'owner_returned')
  }

  const summary = [...children.keys()].sort().join(',')
  if (summary !== lastAdoptedSummary || decisions.adopt.length > 0 || decisions.release.length > 0) {
    if (summary !== lastAdoptedSummary) {
      lastAdoptedSummary = summary
      blog(`lease-beat roles=${summary} nodeId=${NODE_ID} freshPeers=${fresh.length} designated=${decisions.designatedId}`)
    }
  }
}

if (!isSqlite && BASE_ROLE !== 'all') {
  try {
    const { PrismaClient } = require('@prisma/client')
    leaseDb = new PrismaClient()
    leaseEnsureTable(leaseDb)
      .then(() => {
        leaseReady = true
        blog('lease-table-ok (pre-created)')
      })
      .catch((err) => blog(`lease-table-init-deferred err=${String(err?.message || err).slice(0, 200)}`))
    // First beat immediately, then steady-state every 15s. All failures are
    // contained: a broken lease DB only disables failover, never the daemon.
    const runBeat = () => { leaseBeat().catch(err => blog(`lease-beat-err ${String(err?.message || err).slice(0, 200)}`)) }
    runBeat()
    setInterval(runBeat, LEASE_BEAT_MS)
    console.log(`[10X RPC Server] Pillar failover controller active (nodeId=${NODE_ID}, base=${BASE_ROLE}, ttl=${LEASE_TTL_SEC}s).`)
  } catch (err) {
    blog(`lease-init-FAIL err=${String(err?.message || err).slice(0, 300)}`)
    console.warn('[10X RPC Server] Pillar failover disabled (Prisma client unavailable):', err.message)
  }
} else {
  blog(`lease-controller-skipped sqlite=${isSqlite} role=${BASE_ROLE}`)
  if (BASE_ROLE === 'all') console.log('[10X RPC Server] Combined daemon (DAEMON_ROLE=all) — covers every pillar, failover controller not needed.')
}

// ---------- Supervisor watchdog: kill a HUNG daemon (stale heartbeat) ----------
setInterval(() => {
  for (const rec of [...children.values()]) {
    const hb = readHeartbeat(rec.heartbeatFile)
    if (hb && hb.ageSec <= HEARTBEAT_MAX_AGE_SEC) {
      rec.lastSeenHeartbeatAt = Date.now()
      continue
    }
    const sinceSeenSec = Math.floor((Date.now() - rec.lastSeenHeartbeatAt) / 1000)
    if (sinceSeenSec > WATCHDOG_KILL_AFTER_SEC) {
      console.error(`[10X RPC Server] Supervisor: daemon role=${rec.role} heartbeat stale for ${sinceSeenSec}s (no fresh heartbeat). Killing hung daemon for restart...`)
      blog(`watchdog-kill role=${rec.role} staleSec=${sinceSeenSec}`)
      rec.lastSeenHeartbeatAt = Date.now() // reset window; close handler will restart the child
      try {
        if (rec.proc && rec.proc.exitCode === null) rec.proc.kill('SIGKILL')
      } catch (err) {
        console.error(`[10X RPC Server] Supervisor kill role=${rec.role} failed:`, err.message)
      }
    }
  }
}, 60000)

// ---------- Graceful shutdown handling ----------
process.on('uncaughtException', (err) => {
  blog(`SUPERVISOR-UNCAUGHT ${err && err.stack ? String(err.stack).slice(0, 500) : err}`)
  console.error('[10X RPC Server] Uncaught exception (supervisor stays alive):', err)
})
process.on('unhandledRejection', (reason) => {
  blog(`SUPERVISOR-UNHANDLED ${String(reason).slice(0, 500)}`)
  console.error('[10X RPC Server] Unhandled rejection (supervisor stays alive):', reason)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[10X RPC Server] Received ${signal}. Shutting down...`)
    blog(`supervisor-${signal} children=${[...children.keys()].join(',')}`)
    server.close()
    for (const rec of [...children.values()]) {
      try { if (rec.proc && rec.proc.exitCode === null) rec.proc.kill(signal) } catch {}
    }
    process.exit(0)
  })
}
