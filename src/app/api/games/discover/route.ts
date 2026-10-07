// 10X RPC — /api/games/discover — search Discord's PUBLIC Application Directory
// (the same data that powers discord.com/discovery/applications) and return
// candidates with their Application IDs for one-click game auto-config.
//
// The upstream endpoint is Discord's unauthenticated
//   GET /api/v9/application-directory-static/search?query=...&locale=en-US&limit=N
// (verified live). It returns applications with id/name/icon/description/
// verified/category data. We proxy it server-side (no CORS, tiny payload),
// normalize it for the Game RPC search UI, and cache results in memory.
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { DISCORD_APP_ID_RE } from '@/lib/games'

export const dynamic = 'force-dynamic'

interface DirectoryEntry {
  id?: string
  name?: string
  icon?: string | null
  cover_image?: string | null
  description?: string | null
  is_verified?: boolean
  is_discoverable?: boolean
  tags?: string[]
  categories?: Array<{ id?: number; name?: string }>
  bot?: unknown
}

export interface DiscoveredApp {
  appId: string
  name: string
  iconUrl: string | null
  coverUrl: string | null
  description: string
  verified: boolean
  isGame: boolean
  tags: string[]
}

// In-memory result cache + single-flight (10 min TTL)
const CACHE_TTL_MS = 10 * 60 * 1000
const cache = new Map<string, { at: number; results: DiscoveredApp[] }>()
const inflight = new Map<string, Promise<DiscoveredApp[]>>()

function iconToUrl(appId: string, icon: string | null | undefined, size = 128): string | null {
  if (!icon) return null
  const ext = icon.startsWith('a_') ? 'gif' : 'png'
  return `https://cdn.discordapp.com/app-icons/${appId}/${icon}.${ext}?size=${size}`
}

function coverToUrl(appId: string, hash: string | null | undefined): string | null {
  if (!hash) return null
  return `https://cdn.discordapp.com/app-assets/${appId}/${hash}.png`
}

function normalize(raw: DirectoryEntry): DiscoveredApp | null {
  const appId = String(raw.id || '')
  const name = String(raw.name || '').trim()
  if (!DISCORD_APP_ID_RE.test(appId) || !name) return null
  const categories = Array.isArray(raw.categories) ? raw.categories : []
  return {
    appId,
    name: name.slice(0, 64),
    iconUrl: iconToUrl(appId, raw.icon),
    coverUrl: coverToUrl(appId, raw.cover_image),
    description: String(raw.description || '').slice(0, 200),
    verified: !!raw.is_verified,
    isGame: categories.some(c => String(c?.name || '').toLowerCase() === 'games'),
    tags: Array.isArray(raw.tags) ? raw.tags.slice(0, 5) : [],
  }
}

async function searchDiscordDirectory(query: string, limit: number): Promise<DiscoveredApp[]> {
  const url = `https://discord.com/api/v9/application-directory-static/search?query=${encodeURIComponent(query)}&locale=en-US&limit=${limit}`
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': '10X-RPC (https://10x-rpc.vercel.app)',
    },
    signal: AbortSignal.timeout(9000),
  })
  if (!res.ok) {
    throw new Error(`discord_search_${res.status}`)
  }
  const data = (await res.json()) as { results?: Array<{ type?: number; data?: DirectoryEntry }> }
  const out: DiscoveredApp[] = []
  const seen = new Set<string>()
  for (const r of data.results || []) {
    const app = normalize(r?.data || {})
    if (!app || seen.has(app.appId)) continue
    seen.add(app.appId)
    out.push(app)
  }
  // Games first, then verified, preserving Discord's relevance order inside groups.
  out.sort((a, b) => {
    if (a.isGame !== b.isGame) return a.isGame ? -1 : 1
    if (a.verified !== b.verified) return a.verified ? -1 : 1
    return 0
  })
  return out
}

export async function GET(req: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const q = (searchParams.get('q') || '').trim().slice(0, 64)
  const limit = Math.min(12, Math.max(1, Number(searchParams.get('limit')) || 8))
  if (q.length < 2) {
    return NextResponse.json({ ok: true, results: [] })
  }

  const key = `${q.toLowerCase()}::${limit}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return NextResponse.json({ ok: true, results: hit.results, cached: true })
  }

  const running = inflight.get(key)
  if (running) {
    const results = await running
    return NextResponse.json({ ok: true, results })
  }

  const job = searchDiscordDirectory(q, limit)
    .then(results => {
      cache.set(key, { at: Date.now(), results })
      return results
    })
    .catch((err): DiscoveredApp[] => {
      console.error('[games/discover] Discord directory search failed:', err?.message || err)
      return []
    })
    .finally(() => {
      inflight.delete(key)
    })
  inflight.set(key, job)

  const results = await job
  return NextResponse.json({ ok: true, results })
}
