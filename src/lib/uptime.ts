// 10X RPC — 24/7 uptime + region/ping probing (powers /api/uptime and /uptime).
// Measures REAL latency from the server to every backend component:
//   • Database (Neon)            — SELECT 1 round-trip
//   • 24/7 daemon (Orihost node) — GET /status round-trip + live session stats
//   • Discord API                — GET /gateway round-trip
//   • Pterodactyl node (DE-02)   — panel resources (state / CPU / RAM / uptime)
// Results are cached ~45s so auto-refreshing browsers don't hammer probes.
import { db } from '@/lib/db'

export interface UptimeProbe {
  ok: boolean
  latencyMs: number | null
  error?: string
}

export interface DaemonReport extends UptimeProbe {
  configured: boolean
  running?: boolean
  daemonUptimeSeconds?: number
  heartbeatAgeSec?: number | null
  lastTickAt?: string | null
  activeConnections?: number
  totalTrackedUsers?: number
  authFailedUsers?: number
  platforms?: Record<string, number>
  /** Task 107 — per-node detail when ORIHOST_DAEMON_URL lists several nodes
   *  (the 3-node Orihost split: status / rpc / game). */
  nodes?: Array<{
    url: string
    ok: boolean
    latencyMs: number | null
    error?: string
    running?: boolean
    /** Task 118 — pillar visibility: which DAEMON_ROLE the node runs and
     *  which pillars it ADOPTED (failover for a dead peer). */
    role?: string
    adopted?: string[]
    /** Per-child detail (base + adopted pillars) when the supervisor runs a
     *  failover child. Additive — old nodes omit it. */
    children?: Array<{ role: string; isBase?: boolean; heartbeatAgeSec?: number | null; connected?: number | null; trackedUsers?: number | null }>
  }>
}

export interface NodeReport extends UptimeProbe {
  configured: boolean
  name?: string
  state?: string
  maintenance?: boolean
  uptimeSeconds?: number
  memoryMb?: number
  memoryLimitMb?: number
  cpuPercent?: number
}

export interface UptimeReport {
  ok: boolean
  operational: boolean
  degraded: boolean
  checkedAt: string
  serverRegion: string
  website: { ok: true }
  database: UptimeProbe
  discord: UptimeProbe
  daemon: DaemonReport
  node: NodeReport
}

const CACHE_TTL_MS = 45_000
const NODE_NAME_TTL_MS = 60 * 60_000
const PROBE_TIMEOUT_MS = 6_000
// The hosting-panel probe is auxiliary (only feeds the maintenance badge) and
// some panels rate-limit/slow-respond datacenter IPs — keep it snappy and never
// let it fail the overall status.
const NODE_PROBE_TIMEOUT_MS = 4_000

let cache: { at: number; report: UptimeReport } | null = null
let nodeNameCache: { at: number; name: string } | null = null

async function timedFetch(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<{ probe: UptimeProbe; body: string | null }> {
  const t0 = Date.now()
  try {
    const res = await fetch(url, {
      ...init,
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    })
    const latencyMs = Date.now() - t0
    if (!res.ok) {
      return { probe: { ok: false, latencyMs, error: `HTTP ${res.status}` }, body: null }
    }
    return { probe: { ok: true, latencyMs }, body: await res.text() }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { probe: { ok: false, latencyMs: Date.now() - t0, error: msg }, body: null }
  }
}

async function probeDatabase(): Promise<UptimeProbe> {
  const t0 = Date.now()
  try {
    await db.$queryRaw`SELECT 1`
    return { ok: true, latencyMs: Date.now() - t0 }
  } catch (e) {
    return { ok: false, latencyMs: null, error: e instanceof Error ? e.message : 'db unreachable' }
  }
}

async function probeDiscord(): Promise<UptimeProbe> {
  const { probe } = await timedFetch(
    'https://discord.com/api/v10/gateway',
    undefined,
    PROBE_TIMEOUT_MS,
  )
  return probe
}

/** Task 107 — ORIHOST_DAEMON_URL is a COMMA-SEPARATED list of node base URLs
 *  (presence-sync.ts splits it the same way for /sync broadcasts). The uptime
 *  probe used to treat the whole env var as ONE URL → "Failed to parse URL
 *  from http://…,http://…,http://…/status" → the uptime page reported the
 *  daemon down (operational:false) even with all three nodes healthy. */
function orihostDaemonBases(): string[] {
  return (process.env.ORIHOST_DAEMON_URL || '')
    .split(',')
    .map(s => s.trim().replace(/\/+$/, ''))
    .filter(Boolean)
}

interface DaemonStatusBody {
  heartbeatAgeSec?: number | null
  daemon?: { status?: Record<string, unknown>; iso?: string; role?: string } | null
  status?: Record<string, unknown>
  /** Task 118 — supervisor multi-child payload (additive). */
  role?: string
  adopted?: string[]
  children?: Array<{ role?: string; isBase?: boolean; heartbeatAgeSec?: number | null; status?: Record<string, unknown> }>
  lease?: { nodeId?: string; baseRole?: string; adopted?: string[]; db?: string }
}

function parseDaemonStatus(body: string): {
  running?: boolean
  uptimeSeconds?: number
  heartbeatAgeSec?: number | null
  lastTickAt?: string | null
  activeConnections?: number
  totalTrackedUsers?: number
  authFailedUsers?: number
  platforms: Record<string, number>
  role?: string
  adopted?: string[]
  children?: Array<{ role: string; isBase?: boolean; heartbeatAgeSec?: number | null; connected?: number | null; trackedUsers?: number | null }>
} | null {
  try {
    const parsed = JSON.parse(body) as DaemonStatusBody
    const st = (parsed.daemon?.status ?? parsed.status ?? {}) as {
      running?: boolean
      uptimeSeconds?: number
      lastTickAt?: string | null
      activeConnections?: number
      totalTrackedUsers?: number
      authFailedUsers?: number
      users?: { platform?: string }[]
    }
    const platforms: Record<string, number> = {}
    for (const u of st.users ?? []) {
      const p = u.platform || 'unknown'
      platforms[p] = (platforms[p] ?? 0) + 1
    }

    // Task 118 — adopted/failover children: aggregate their live counters ON
    // TOP of the base child so a node carrying a dead peer's pillar reports
    // the truth. Old single-child payloads have no children[] → unchanged.
    let activeConnections = st.activeConnections
    let totalTrackedUsers = st.totalTrackedUsers
    let authFailedUsers = st.authFailedUsers
    const kids = (parsed.children ?? []).map(c => ({
      role: String(c.role || 'unknown'),
      isBase: c.isBase === true,
      heartbeatAgeSec: typeof c.heartbeatAgeSec === 'number' ? c.heartbeatAgeSec : null,
      connected: (c.status as { activeConnections?: number } | undefined)?.activeConnections ?? null,
      trackedUsers: (c.status as { totalTrackedUsers?: number } | undefined)?.totalTrackedUsers ?? null,
    }))
    if (kids.length > 0) {
      const sumField = (pick: (c: (typeof kids)[number]) => number | null) =>
        kids.reduce<number>((acc, c) => { const v = pick(c); return typeof v === 'number' ? acc + v : acc }, 0)
      activeConnections = sumField(c => c.connected)
      totalTrackedUsers = sumField(c => c.trackedUsers)
      for (const c of kids) {
        const cStatus = (parsed.children ?? []).find(x => String(x.role) === c.role)?.status as { users?: { platform?: string }[] } | undefined
        for (const u of cStatus?.users ?? []) {
          const p = u.platform || 'unknown'
          platforms[p] = (platforms[p] ?? 0) + 1
        }
      }
    }

    return {
      running: st.running,
      uptimeSeconds: st.uptimeSeconds,
      heartbeatAgeSec: typeof parsed.heartbeatAgeSec === 'number' ? parsed.heartbeatAgeSec : null,
      lastTickAt: st.lastTickAt ?? null,
      activeConnections,
      totalTrackedUsers,
      authFailedUsers,
      platforms,
      role: parsed.daemon?.role ?? parsed.role,
      adopted: Array.isArray(parsed.adopted) ? parsed.adopted.map(String) : undefined,
      children: kids.length > 0 ? kids : undefined,
    }
  } catch {
    return null
  }
}

async function probeDaemon(): Promise<DaemonReport> {
  const bases = orihostDaemonBases()
  if (bases.length === 0) return { configured: false, ok: false, latencyMs: null, error: 'ORIHOST_DAEMON_URL not set' }

  // Probe EVERY node in parallel (3-node split: status / rpc / game roles).
  const results = await Promise.all(
    bases.map(async base => {
      const { probe, body } = await timedFetch(`${base}/status`, undefined, PROBE_TIMEOUT_MS)
      if (!probe.ok || !body) {
        return { url: base, ok: false, latencyMs: probe.latencyMs, error: probe.error, running: undefined, st: null }
      }
      const st = parseDaemonStatus(body)
      if (!st) return { url: base, ok: false, latencyMs: probe.latencyMs, error: 'invalid /status payload', running: undefined, st: null }
      return { url: base, ok: probe.ok && st.running === true, latencyMs: probe.latencyMs, running: st.running, st }
    })
  )

  const ok = results.length > 0 && results.every(r => r.ok)
  // Worst-case latency represents the probe honestly; single-node setups behave exactly as before.
  const latencyMs = results.reduce<number | null>((worst, r) => {
    if (typeof r.latencyMs !== 'number') return worst
    return worst === null ? r.latencyMs : Math.max(worst, r.latencyMs)
  }, null)
  const firstErr = results.find(r => !r.ok)
  const stats = results.map(r => r.st).filter((s): s is NonNullable<typeof s> => !!s)
  const sum = (pick: (s: NonNullable<typeof stats[number]>) => number | undefined): number | undefined => {
    const vals = stats.map(pick).filter((v): v is number => typeof v === 'number')
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) : undefined
  }
  const platforms: Record<string, number> = {}
  for (const st of stats) {
    for (const [p, n] of Object.entries(st.platforms)) platforms[p] = (platforms[p] ?? 0) + n
  }
  const uptimes = stats.map(s => s.uptimeSeconds).filter((v): v is number => typeof v === 'number')
  const heartbeats = stats.map(s => s.heartbeatAgeSec).filter((v): v is number => typeof v === 'number')
  const lastTicks = stats.map(s => s.lastTickAt).filter((v): v is string => typeof v === 'string')

  return {
    configured: true,
    ok,
    latencyMs,
    error: ok ? undefined : (firstErr?.error ?? 'one or more daemon nodes unreachable'),
    running: results.some(r => r.running === true),
    daemonUptimeSeconds: uptimes.length > 0 ? Math.max(...uptimes) : undefined,
    heartbeatAgeSec: heartbeats.length > 0 ? Math.max(...heartbeats) : null,
    lastTickAt: lastTicks.sort().at(-1) ?? null,
    activeConnections: sum(s => s.activeConnections),
    totalTrackedUsers: sum(s => s.totalTrackedUsers),
    authFailedUsers: sum(s => s.authFailedUsers),
    platforms,
    nodes: results.map(({ url, ok: nodeOk, latencyMs: l, error, running, st }) => ({
      url,
      ok: nodeOk,
      latencyMs: l,
      error,
      running,
      // Task 118 — pillar visibility (additive): role, adopted pillars and
      // per-child detail so the status page can show WHICH pillar a dead node
      // took down and who is covering it.
      role: st?.role,
      adopted: st?.adopted,
      children: st?.children,
    })),
  }
}

async function probeNode(): Promise<NodeReport> {
  const panel = process.env.PTERODACTYL_URL
  const key = process.env.PTERODACTYL_API_KEY
  const serverId = process.env.PTERODACTYL_SERVER_ID
  if (!panel || !key || !serverId) {
    return { configured: false, ok: false, latencyMs: null, error: 'Pterodactyl not configured' }
  }
  const headers = {
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
  }

  const meta = await timedFetch(
    `${panel}/api/client/servers/${serverId}`,
    { headers },
    NODE_PROBE_TIMEOUT_MS,
  )
  if (!meta.probe.ok || !meta.body) return { configured: true, ...meta.probe }

  // Node name changes ~never — cache it for an hour, then probe resources only.
  let name = nodeNameCache?.at && Date.now() - nodeNameCache.at < NODE_NAME_TTL_MS ? nodeNameCache.name : undefined
  if (!name) {
    try {
      const j = JSON.parse(meta.body) as { attributes?: { node?: string } }
      name = j.attributes?.node || 'unknown'
      nodeNameCache = { at: Date.now(), name }
    } catch {
      name = 'unknown'
    }
  }

  const res = await timedFetch(
    `${panel}/api/client/servers/${serverId}/resources`,
    { headers },
    NODE_PROBE_TIMEOUT_MS,
  )
  if (!res.probe.ok || !res.body) return { configured: true, name, ...res.probe }

  try {
    const j = JSON.parse(res.body) as {
      attributes?: {
        current_state?: string
        is_suspended?: boolean
        resources?: {
          uptime?: number
          memory_bytes?: number
          cpu_absolute?: number
        }
      }
    }
    const a = j.attributes
    const memLimit = 512 // MB — Orihost free plan limit
    return {
      configured: true,
      ok: res.probe.ok && a?.current_state === 'running',
      latencyMs: res.probe.latencyMs,
      name,
      state: a?.current_state,
      maintenance: a?.is_suspended === true,
      uptimeSeconds: a?.resources?.uptime ? Math.round(a.resources.uptime / 1000) : undefined,
      memoryMb: a?.resources?.memory_bytes ? Math.round(a.resources.memory_bytes / (1024 * 1024)) : undefined,
      memoryLimitMb: memLimit,
      cpuPercent: a?.resources?.cpu_absolute,
    }
  } catch {
    return { configured: true, name, ...res.probe }
  }
}

export async function getUptimeReport(force = false): Promise<UptimeReport> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.report

  const [database, discord, daemon, node] = await Promise.all([
    probeDatabase(),
    probeDiscord(),
    probeDaemon(),
    probeNode(),
  ])

  // Node/panel probe failure must NOT degrade the page banner: it's auxiliary
  // (maintenance badge only) and the panel often times out from serverless IPs.
  // Real health = database + discord + the 24/7 daemon itself.
  const criticalDown = !database.ok || (daemon.configured && !daemon.ok)
  const softDown = !discord.ok

  const report: UptimeReport = {
    ok: true,
    operational: !criticalDown && !softDown,
    degraded: !criticalDown && softDown,
    checkedAt: new Date().toISOString(),
    serverRegion: process.env.VERCEL_REGION || 'local',
    website: { ok: true },
    database,
    discord,
    daemon,
    node,
  }
  cache = { at: Date.now(), report }
  return report
}
