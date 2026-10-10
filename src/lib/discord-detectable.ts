// 10X RPC — Discord DETECTABLE GAMES catalog search (the "24,600+ games" source).
//
// This is the full catalog Discord's own client uses for game detection —
// every real game Discord can detect on a desktop, each with its REAL
// Application ID, official icon and executable list. The reference
// implementation (standalone-profile-board.js) loads this same endpoint with
// the user token; here it is loaded with the site's BOT token, so it works
// server-side even when a visitor's user token is revoked or absent.
//
// Endpoint: GET /api/v9/applications/detectable  (~24,600 entries, ~13MB)
// Cache strategy:
//   1. In-memory module cache (fast path, survives per-instance).
//   2. Disk cache in os.tmpdir() (Vercel serverless allows /tmp writes) with
//      a 24h TTL — a cold start then costs one 13MB download per day.
// Search scoring mirrors the reference implementation exactly:
//   exact name match = 100, name starts with query = 80,
//   name contains query = 50, executable contains query = 30;
//   ties broken by shorter name first.

import os from 'os'
import path from 'path'
import fs from 'fs'

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'
const DETECTABLE_URL = 'https://discord.com/api/v9/applications/detectable'
const FETCH_TIMEOUT_MS = 12000
const DISK_TTL_MS = 24 * 60 * 60 * 1000

interface DetectableEntry {
  id: string | number
  name: string
  icon_hash?: string | null
  description?: string | null
  executables?: Array<{ name?: string | null }> | null
}

export interface DetectableGame {
  appId: string
  name: string
  iconUrl: string | null
  description: string
  verified: boolean
  isGame: true
}

// --- module-level cache ---
let memoryCache: DetectableEntry[] | null = null
let memoryCacheAt = 0
let inflight: Promise<DetectableEntry[]> | null = null

const DISK_FILE = path.join(os.tmpdir(), '10x-detectable-games.json')

function readDiskCache(): DetectableEntry[] | null {
  try {
    if (!fs.existsSync(DISK_FILE)) return null
    const stat = fs.statSync(DISK_FILE)
    if (Date.now() - stat.mtimeMs > DISK_TTL_MS) return null
    const data = JSON.parse(fs.readFileSync(DISK_FILE, 'utf8'))
    return Array.isArray(data) && data.length > 0 ? data : null
  } catch {
    return null
  }
}

function writeDiskCache(data: DetectableEntry[]) {
  try {
    fs.writeFileSync(DISK_FILE, JSON.stringify(data))
  } catch {
    // Disk cache is best-effort — in-memory cache still covers the instance.
  }
}

/** Fetch the full detectable catalog (bot token) with memory + disk caching.
 * Concurrent callers share one in-flight request. Failures degrade to an
 * empty array (or a stale disk cache if one exists) so search never blocks. */
async function loadDetectableGames(): Promise<DetectableEntry[]> {
  if (memoryCache && memoryCache.length > 0) return memoryCache

  const disk = readDiskCache()
  if (disk) {
    memoryCache = disk
    memoryCacheAt = Date.now()
    return disk
  }

  if (inflight) return inflight
  inflight = (async () => {
    try {
      const token = process.env.DISCORD_BOT_TOKEN
      if (!token) return []
      const res = await fetch(DETECTABLE_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': UA,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        cache: 'no-store',
      })
      if (!res.ok) return []
      const data = (await res.json()) as DetectableEntry[]
      if (!Array.isArray(data) || data.length === 0) return []
      memoryCache = data
      memoryCacheAt = Date.now()
      writeDiskCache(data)
      return data
    } catch {
      return []
    } finally {
      inflight = null
    }
  })()
  return inflight
}

function toGame(g: DetectableEntry): DetectableGame | null {
  const appId = String(g?.id ?? '').trim()
  const name = String(g?.name ?? '').trim()
  if (!/^\d{15,21}$/.test(appId) || !name) return null
  return {
    appId,
    name,
    iconUrl:
      typeof g?.icon_hash === 'string' && g.icon_hash
        ? `https://cdn.discordapp.com/app-icons/${appId}/${g.icon_hash}.png?size=128`
        : null,
    description: String(g?.description || '').replace(/\s+/g, ' ').trim().slice(0, 140),
    verified: false,
    isGame: true,
  }
}

/** Scored search across the 24,600+ detectable games — the same ranking the
 * reference implementation uses (exact > prefix > contains > executable). */
export async function searchDetectableGames(query: string, limit = 30): Promise<DetectableGame[]> {
  const q = query.trim().toLowerCase()
  if (q.length < 1) return []
  const games = await loadDetectableGames()
  if (games.length === 0) return []

  const scored: Array<{ g: DetectableEntry; score: number }> = []
  for (const g of games) {
    const name = String(g?.name ?? '')
    if (!name) continue
    const nameLower = name.toLowerCase()
    let score = 0
    if (nameLower === q) score = 100
    else if (nameLower.startsWith(q)) score = 80
    else if (nameLower.includes(q)) score = 50
    else if ((g.executables || []).some(e => e?.name && e.name.toLowerCase().includes(q))) score = 30
    if (score > 0) scored.push({ g, score })
  }

  scored.sort((a, b) => b.score - a.score || a.g.name.length - b.g.name.length)
  const out: DetectableGame[] = []
  for (const { g } of scored.slice(0, Math.min(60, Math.max(limit, 1)) * 2)) {
    const mapped = toGame(g)
    if (mapped) out.push(mapped)
    if (out.length >= Math.min(60, Math.max(limit, 1))) break
  }
  return out
}

/** Popular games shown for an empty query (same curated IDs as the reference
 * implementation, resolved against the live catalog). */
const POPULAR_IDS = [
  '1272842103910699040', '1276737795012165766', '1174041358995042375',
  '358421669603311616', '385538724592746496', '1124358970618953818',
  '1402418491272986635', '1402418714716143646', '700136079562375258',
  '762434991303950386', '1158877933042143272', '363445589247131668',
  '1402418703554842694', '398632010442211348', '905961880789590076',
]

export async function getPopularDetectableGames(limit = 12): Promise<DetectableGame[]> {
  const games = await loadDetectableGames()
  if (games.length === 0) return []
  const byId = new Map(games.map(g => [String(g?.id ?? ''), g]))
  const out: DetectableGame[] = []
  for (const id of POPULAR_IDS) {
    const g = byId.get(id)
    if (!g) continue
    const mapped = toGame(g)
    if (mapped) out.push(mapped)
    if (out.length >= limit) break
  }
  return out
}

/** Warms the catalog (fire-and-forget) — called after a successful login so
 * the first search is instant. */
export function warmDetectableGames() {
  loadDetectableGames().catch(() => {})
}

/** Total number of games currently cached (for UI stats). */
export function detectableCacheSize(): number {
  return memoryCache?.length ?? 0
}

export function detectableCacheAgeMs(): number {
  return memoryCache ? Date.now() - memoryCacheAt : -1
}
