// 10X RPC — Discord TRENDING GAMES index (real games only, no bots).
//
// Source: https://discord.com/trending-games/ — Discord's official weekly
// trending-games ranking. The pages are server-rendered and embed schema.org
// JSON-LD (`@type: "VideoGame"`) entries carrying the game's REAL Discord
// Application ID and official CDN icon. Unlike the old application-directory
// search (which is dominated by bots/server-status tools — NOT games), every
// entry here is an actual video game published by Discord's discovery team.
//
// We build an in-memory index from: the current week's main page + every
// category page + the previous couple of weekly archives (each page lists
// 10-20 games). The union of recent weeks/categories is a few hundred REAL
// games — that is what powers the Game RPC search bar.

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'
const BASE = 'https://discord.com/trending-games'

const CATEGORY_SLUGS = [
  'adventure', 'crafting', 'fantasy', 'fps', 'horror', 'indie', 'mmo',
  'open-world', 'rpg', 'sandbox', 'sci-fi', 'shooter', 'simulation',
  'sports', 'story-rich', 'strategy', 'survival', 'tactical',
]

/** How many previous weekly archives to union into the index. */
const PAST_WEEKS = 4
const FETCH_TIMEOUT_MS = 4500
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour — the list changes weekly

export interface TrendingGame {
  appId: string
  name: string
  iconUrl: string | null
  /** Lower = more prominent on Discord's trending pages. */
  rank: number
}

interface CacheEntry {
  builtAt: number
  games: TrendingGame[]
}

let cache: CacheEntry | null = null
let inflight: Promise<TrendingGame[]> | null = null

function dayString(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return dayString(d)
}

async function fetchPage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: 'no-store',
    })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

interface RawGame { name: string; identifier: string; image?: string }

/** Parse VideoGame entries out of a page's embedded JSON-LD (with a raw
 * regex fallback for resilience against markup changes). */
function parseGames(html: string): TrendingGame[] {
  const out: TrendingGame[] = []

  const eat = (raw: RawGame[], offset: number) => {
    for (const g of raw) {
      const appId = String(g.identifier || '').trim()
      const name = String(g.name || '').trim()
      if (!/^\d{15,21}$/.test(appId) || !name) continue
      out.push({
        appId,
        name,
        iconUrl: typeof g.image === 'string' && g.image.startsWith('https://') ? g.image : null,
        rank: offset + out.length,
      })
    }
  }

  // Preferred: schema.org JSON-LD block → CollectionPage.mainEntity ItemList
  const ldMatch = html.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/)
  if (ldMatch) {
    try {
      const data = JSON.parse(ldMatch[1])
      const graph = Array.isArray(data?.['@graph']) ? data['@graph'] : [data]
      let offset = 0
      for (const node of graph) {
        const items = node?.mainEntity?.itemListElement ?? node?.itemListElement
        if (!Array.isArray(items)) continue
        const games = items
          .map((it: any) => it?.item)
          .filter((it: any) =>
            it && (it['@type'] === 'VideoGame' || (Array.isArray(it['@type']) && it['@type'].includes('VideoGame')))
          )
        eat(games, offset)
        offset += games.length
      }
    } catch {
      // fall through to the raw scan
    }
  }

  // Fallback: raw ListItem/VideoGame scan across the whole document.
  if (out.length === 0) {
    const re = /\{"@type":"ListItem","position":\d+,"item":\{"@type":"VideoGame","name":"((?:[^"\\]|\\.)*)","identifier":"(\d+)","image":"((?:[^"\\]|\\.)*)"/g
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) !== null) {
      try {
        eat([{ name: JSON.parse(`"${m[1]}"`) as string, identifier: m[2], image: JSON.parse(`"${m[3]}"`) as string }], out.length)
      } catch {
        // ignore malformed entry
      }
    }
  }

  return out
}

/** Current week date (YYYY-MM-DD) as Discord slugs its weekly archives. */
function extractWeekDate(mainHtml: string | null): string {
  if (mainHtml) {
    const m = mainHtml.match(/trending-games\/(\d{4}-\d{2}-\d{2})/)
    if (m) return m[1]
  }
  return dayString(new Date())
}

async function buildIndex(): Promise<TrendingGame[]> {
  const mainHtml = await fetchPage(`${BASE}/`)
  const week = extractWeekDate(mainHtml)

  const urls: string[] = []
  if (mainHtml) urls.push(`${BASE}/`) // current main page first (highest rank)
  for (let w = 0; w <= PAST_WEEKS; w++) {
    const d = shiftDays(week, -7 * w)
    if (w > 0) urls.push(`${BASE}/${d}`)
    for (const slug of CATEGORY_SLUGS) {
      if (w === 0) urls.push(`${BASE}/category/${slug}/${week}`)
    }
  }

  const pages = await Promise.all(urls.map(u => fetchPage(u)))
  const all: TrendingGame[] = []
  for (const html of pages) {
    if (html) all.push(...parseGames(html))
  }

  // Dedupe by appId AND by name (case-insensitive), keeping the best rank.
  const byApp = new Map<string, TrendingGame>()
  const byName = new Set<string>()
  for (const g of all.sort((a, b) => a.rank - b.rank)) {
    if (byApp.has(g.appId)) continue
    const key = g.name.toLowerCase()
    if (byName.has(key)) continue
    byApp.set(g.appId, g)
    byName.add(key)
  }
  const games = [...byApp.values()]
  games.forEach((g, i) => { g.rank = i })
  return games
}

/** The trending index (cached; serves the last good snapshot if a rebuild fails). */
export async function getTrendingIndex(): Promise<TrendingGame[]> {
  if (cache && Date.now() - cache.builtAt < CACHE_TTL_MS) return cache.games
  if (inflight) return inflight

  inflight = buildIndex()
    .then(games => {
      if (games.length > 0) {
        cache = { builtAt: Date.now(), games }
        return games
      }
      // Build produced nothing (e.g. Discord unreachable) — stale cache wins.
      return cache?.games ?? games
    })
    .finally(() => {
      inflight = null
    })

  return inflight
}

/** Ranked search over the real-games trending index. */
export async function searchTrendingGames(query: string, limit = 8): Promise<TrendingGame[]> {
  const q = query.trim().toLowerCase()
  if (q.length < 2) return []
  const games = await getTrendingIndex()
  if (games.length === 0) return []

  const qWords = q.split(/\s+/).filter(Boolean)
  const initialsOf = (name: string) => name.split(/[\s\-:'’!,.]+/).filter(Boolean).map(w => w[0]).join('')
  const qIsInitialism = q.length >= 2 && q.length <= 6 && /^[a-z0-9]+$/.test(q)
  const scored: Array<{ g: TrendingGame; tier: number }> = []
  for (const g of games) {
    const name = g.name.toLowerCase()
    let tier: number
    if (name === q) tier = 0
    else if (name.startsWith(q)) tier = 1
    else if (qWords.length > 1 && qWords.every(w => name.includes(w))) tier = 2
    else if (qIsInitialism && (initialsOf(name) === q || initialsOf(name).startsWith(q))) tier = 2
    // "gta" → "Grand Theft Auto V Enhanced", "cs2" → "Counter-Strike 2"
    else if (new RegExp(`\\b${qWords[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(name)) tier = 3
    else if (name.includes(q)) tier = 4
    else continue
    scored.push({ g, tier })
  }

  scored.sort((a, b) => a.tier - b.tier || a.g.rank - b.g.rank)
  return scored.slice(0, limit).map(s => s.g)
}
