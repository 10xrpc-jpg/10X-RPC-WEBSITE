// 10X RPC — /api/games/discover — Game RPC search bar source.
//
// TWO complementary sources, so the search bar shows ALL real-game results:
//
// 1. TRENDING GAMES (https://discord.com/trending-games/) — Discord's official
//    weekly ranking. Every entry is a real video game with its real Discord
//    Application ID and official icon, parsed from the pages' embedded
//    JSON-LD. These rank first because they are real games. See
//    lib/discord-trending.ts.
//
// 2. DETECTABLE GAMES CATALOG (lib/discord-detectable.ts) — the full catalog
//    Discord's client uses for game detection: ~24,600 real games, each with
//    its REAL Application ID, official icon and executables. Scored search
//    (exact > prefix > contains > executable) exactly like the reference
//    implementation, cached in memory + /tmp with the site's bot token, so
//    it works even when a visitor's user token is revoked or absent.
//
// (The old third source — the full App Directory search ("All Results On
// Discord") — was removed on request; search results are real games only.)
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { searchTrendingGames } from '@/lib/discord-trending'
import {
  searchDetectableGames,
  getPopularDetectableGames,
  detectableCacheSize,
} from '@/lib/discord-detectable'

export const dynamic = 'force-dynamic'

export interface DiscoveredApp {
  appId: string
  name: string
  iconUrl: string | null
  coverUrl: string | null
  description: string
  verified: boolean
  isGame: boolean
  tags: string[]
  /** Which source produced this result. */
  source: 'trending' | 'detectable'
}

const MAX_RESULTS = 96

export async function GET(req: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const q = (searchParams.get('q') || '').trim().slice(0, 64)
  if (q.length < 2) {
    // Empty/short query → curated Popular Games (used by the Add-a-Game
    // dialogs so they open with instant, tappable suggestions).
    const popular = await getPopularDetectableGames(12).catch(() => [])
    const results: DiscoveredApp[] = popular.map(d => ({
      appId: d.appId,
      name: d.name,
      iconUrl: d.iconUrl,
      coverUrl: null,
      description: 'Popular on Discord',
      verified: d.verified,
      isGame: true,
      tags: [] as string[],
      source: 'detectable' as const,
    }))
    return NextResponse.json({ ok: true, results, popular: true, catalogSize: detectableCacheSize() })
  }

  // Both sources in parallel; a failure on either side degrades to an empty
  // list so one broken source never blocks the other. `limit` lets the UI ask
  // for more results ("See more" button) — default 24, clamped 12..96.
  const rawLimit = Number(searchParams.get('limit') || '24')
  const limit = Number.isFinite(rawLimit)
    ? Math.min(MAX_RESULTS, Math.max(12, Math.floor(rawLimit)))
    : 24

  const [games, detectable] = await Promise.all([
    searchTrendingGames(q, 12).catch(() => []),
    searchDetectableGames(q, limit).catch(() => []),
  ])

  // Trending first (real games, ranked), then the detectable-catalog matches
  // that aren't already covered (dedupe by App ID and lowercase name).
  const seenIds = new Set(games.map(g => g.appId))
  const seenNames = new Set(games.map(g => g.name.toLowerCase()))
  const detectableExtras = detectable.filter(d => {
    const name = d.name.toLowerCase()
    if (seenIds.has(d.appId) || seenNames.has(name)) return false
    seenIds.add(d.appId)
    seenNames.add(name)
    return true
  })

  const results: DiscoveredApp[] = [
    ...games.map(g => ({
      appId: g.appId,
      name: g.name,
      iconUrl: g.iconUrl,
      coverUrl: null,
      description: 'Real game — trending on Discord',
      verified: false,
      isGame: true,
      tags: [] as string[],
      source: 'trending' as const,
    })),
    ...detectableExtras.map(d => ({
      appId: d.appId,
      name: d.name,
      iconUrl: d.iconUrl,
      coverUrl: null,
      description: d.description || 'Real game — Discord detectable catalog',
      verified: d.verified,
      isGame: true,
      tags: [] as string[],
      source: 'detectable' as const,
    })),
  ].slice(0, limit)

  return NextResponse.json({ ok: true, results, catalogSize: detectableCacheSize() })
}
