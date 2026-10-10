// 10X RPC — /api/games/discover — Game RPC search bar source.
//
// THREE complementary sources, so the search bar shows ALL results:
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
// 3. FULL APP DIRECTORY (lib/discord-directory.ts) — Discord's current
//    application-directory search (the endpoint the Discord client uses for
//    its App Directory search box). Covers EVERY published application, so
//    queries the game catalogs can't satisfy (niche games, launchers, rich
//    presence tools like "game rpc") still return their real results, each
//    with its real Application ID. The old /discovery/applications endpoint
//    is gone (404) — this is its successor, authenticated with the site's
//    bot token server-side.
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { searchTrendingGames } from '@/lib/discord-trending'
import { searchDiscordDirectory } from '@/lib/discord-directory'
import {
  searchDetectableGames,
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
  source: 'trending' | 'detectable' | 'directory'
}

const MAX_RESULTS = 36

export async function GET(req: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const q = (searchParams.get('q') || '').trim().slice(0, 64)
  if (q.length < 2) {
    return NextResponse.json({ ok: true, results: [], catalogSize: detectableCacheSize() })
  }

  // All three sources in parallel; a failure on any side degrades to an empty
  // list so one broken source never blocks the others.
  const [games, detectable, directory] = await Promise.all([
    searchTrendingGames(q, 12).catch(() => []),
    searchDetectableGames(q, 24).catch(() => []),
    searchDiscordDirectory(q, 20).catch(() => []),
  ])

  // Trending first (real games, ranked), then the detectable-catalog matches
  // and the full-directory results that aren't already covered (dedupe by
  // App ID and lowercase name).
  const seenIds = new Set(games.map(g => g.appId))
  const seenNames = new Set(games.map(g => g.name.toLowerCase()))
  const dedupe = <T extends { appId: string; name: string }>(list: T[]): T[] =>
    list.filter(d => {
      const id = d.appId
      const name = d.name.toLowerCase()
      if (seenIds.has(id) || seenNames.has(name)) return false
      seenIds.add(id)
      seenNames.add(name)
      return true
    })

  const detectableExtras = dedupe(detectable)
  const directoryExtras = dedupe(directory)

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
    ...directoryExtras.map(d => ({
      appId: d.appId,
      name: d.name,
      iconUrl: d.iconUrl,
      coverUrl: null,
      description: d.description || 'Discord application',
      verified: d.verified,
      isGame: d.isGame,
      tags: [] as string[],
      source: 'directory' as const,
    })),
  ].slice(0, MAX_RESULTS)

  return NextResponse.json({ ok: true, results, catalogSize: detectableCacheSize() })
}
