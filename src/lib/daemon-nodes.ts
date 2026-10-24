// 10X RPC — 24/7 daemon node resolver (env primary + admin DB override).
//
// The website fans instant presence syncs out to every 24/7 daemon node in
// ORIHOST_DAEMON_URL (comma-separated base URLs) and probes them on the
// uptime page. Historically the ONLY way to add/repoint a node was a Vercel
// env change + redeploy. This resolver lets the admin manage the node list
// from the dashboard (PlatformSetting key "daemon_nodes") — same self-serve
// pattern as the Razorpay credentials — while the env list keeps working.
//
//   effective nodes = env list  →  append: override after env
//                               →  replace: override only
//   sync secret     = env ORIHOST_SYNC_SECRET/DAEMON_SYNC_SECRET → DB override
import { db } from '@/lib/db'

export interface DaemonNodesOverride {
  /** Node base URLs (no trailing slash), one per line / comma separated on input. */
  urls: string[]
  /** append = add to the env list · replace = only these URLs. */
  mode: 'append' | 'replace'
  updatedAt?: string
}

const KEY = 'daemon_nodes'
const CACHE_MS = 30_000

export interface ResolvedDaemonNodes {
  envBases: string[]
  effectiveBases: string[]
  override: DaemonNodesOverride | null
  syncSecret: string
  syncSecretSource: 'db' | 'env' | 'none'
}

let cache: { value: ResolvedDaemonNodes; at: number } | null = null

function envBases(): string[] {
  return (process.env.ORIHOST_DAEMON_URL || '')
    .split(',')
    .map(s => s.trim().replace(/\/+$/, ''))
    .filter(Boolean)
}

function envSyncSecret(): string {
  return process.env.ORIHOST_SYNC_SECRET || process.env.DAEMON_SYNC_SECRET || ''
}

/** Normalize a node URL: trim, drop trailing slashes, force http(s), dedupe. */
export function sanitizeNodeUrls(raw: string | string[]): string[] {
  const list = Array.isArray(raw) ? raw : raw.split(/[\n,]/)
  const out: string[] = []
  for (const item of list) {
    let u = String(item || '').trim().replace(/\/+$/, '')
    if (!u) continue
    if (!/^https?:\/\//i.test(u)) u = `http://${u}`
    try {
      const parsed = new URL(u)
      if (!parsed.hostname) continue
      const clean = `${parsed.protocol}//${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '')}`
      if (!out.includes(clean)) out.push(clean)
    } catch {
      // unparsable — skip
    }
  }
  return out
}

function safeParse(json: string): DaemonNodesOverride | null {
  try {
    const v = JSON.parse(json)
    if (!v || typeof v !== 'object') return null
    const mode = v.mode === 'replace' ? 'replace' : 'append'
    const urls = sanitizeNodeUrls(Array.isArray(v.urls) ? v.urls : [])
    return { urls, mode, updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : undefined }
  } catch {
    return null
  }
}

/** Resolved node list + sync secret (cached 30s; env-only on DB errors). */
export async function getDaemonNodes(): Promise<ResolvedDaemonNodes> {
  const env = envBases()
  const envSecret = envSyncSecret()
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value
  let override: DaemonNodesOverride | null = null
  let dbSecret = ''
  try {
    const row = await db.platformSetting.findUnique({ where: { key: KEY } })
    if (row) {
      const parsed = safeParse(row.value)
      override = parsed
      if (parsed && typeof (parsed as DaemonNodesOverride & { syncSecret?: string }).syncSecret === 'string') {
        dbSecret = ((parsed as DaemonNodesOverride & { syncSecret?: string }).syncSecret || '').trim()
      }
    }
  } catch (e) {
    console.error('[daemon-nodes] override read failed (using env):', e)
  }
  const value: ResolvedDaemonNodes = {
    envBases: env,
    override,
    effectiveBases: override
      ? override.mode === 'replace'
        ? override.urls
        : [...env, ...override.urls.filter(u => !env.includes(u))]
      : env,
    syncSecret: dbSecret || envSecret,
    syncSecretSource: dbSecret ? 'db' : envSecret ? 'env' : 'none',
  }
  cache = { value, at: Date.now() }
  return value
}

/** Persist an admin override. Empty urls + replace clears the override effect. */
export async function saveDaemonNodes(patch: { urls?: string | string[]; mode?: 'append' | 'replace'; syncSecret?: string }): Promise<DaemonNodesOverride> {
  const current = cache?.value.override ?? null
  const urls = patch.urls === undefined
    ? (current?.urls ?? [])
    : sanitizeNodeUrls(patch.urls)
  const mode = patch.mode === 'replace' || patch.mode === 'append' ? patch.mode : (current?.mode ?? 'append')
  const prevSecret = cache?.value.syncSecretSource === 'db' ? cache?.value.syncSecret : ''
  const syncSecret = patch.syncSecret !== undefined ? String(patch.syncSecret).trim() : prevSecret
  const next: DaemonNodesOverride & { syncSecret?: string } = { urls, mode, updatedAt: new Date().toISOString() }
  if (syncSecret) next.syncSecret = syncSecret
  await db.platformSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  })
  cache = null
  return next
}

/** Drop the DB override — env list + env secret take over again. */
export async function resetDaemonNodes(): Promise<void> {
  await db.platformSetting.deleteMany({ where: { key: KEY } })
  cache = null
}

/** Invalidate the cache (used after admin writes from any entry point). */
export function bustDaemonNodesCache(): void {
  cache = null
}
