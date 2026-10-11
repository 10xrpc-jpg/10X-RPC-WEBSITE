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

async function probeDaemon(): Promise<DaemonReport> {
  const base = process.env.ORIHOST_DAEMON_URL
  if (!base) return { configured: false, ok: false, latencyMs: null, error: 'ORIHOST_DAEMON_URL not set' }

  const { probe, body } = await timedFetch(`${base}/status`, undefined, PROBE_TIMEOUT_MS)
  if (!probe.ok || !body) return { configured: true, ...probe }

  try {
    const parsed = JSON.parse(body) as {
      heartbeatAgeSec?: number
      daemon?: { status?: Record<string, unknown>; iso?: string }
      status?: Record<string, unknown>
    }
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
    return {
      configured: true,
      ok: probe.ok && st.running === true,
      latencyMs: probe.latencyMs,
      running: st.running,
      daemonUptimeSeconds: st.uptimeSeconds,
      heartbeatAgeSec: typeof parsed.heartbeatAgeSec === 'number' ? parsed.heartbeatAgeSec : null,
      lastTickAt: st.lastTickAt ?? null,
      activeConnections: st.activeConnections,
      totalTrackedUsers: st.totalTrackedUsers,
      authFailedUsers: st.authFailedUsers,
      platforms,
    }
  } catch {
    return { configured: true, ...probe }
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
    PROBE_TIMEOUT_MS,
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
    PROBE_TIMEOUT_MS,
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

  const criticalDown = !database.ok || (daemon.configured && !daemon.ok)
  const softDown = !discord.ok || (node.configured && !node.ok)

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
