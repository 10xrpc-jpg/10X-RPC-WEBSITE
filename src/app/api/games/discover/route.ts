// 10X RPC — /api/games/discover — Game RPC search bar source.
//
// TWO complementary sources, so the search bar shows ALL results:
//
// 1. TRENDING GAMES (https://discord.com/trending-games/) — Discord's official
//    weekly ranking. Every entry is a real video game with its real Discord
//    Application ID and official icon, parsed from the pages' embedded
//    JSON-LD. These rank first because they are real games. See
//    lib/discord-trending.ts.
//
// 2. FULL APP DIRECTORY (lib/discord-directory.ts) — Discord's current
//    application-directory search (the endpoint the Discord client uses for
//    its App Directory search box). Covers EVERY published application, so
//    queries that trending can't satisfy (niche games, launchers, rich
//    presence tools like "game rpc") still return their real results, each
//    with its real Application ID. The old /discovery/applications endpoint
//    is gone (404) — this is its successor, authenticated with the site's
//    bot token server-side.
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { searchTrendingGames } from '@/lib/discord-trending'
import { searchDiscordDirectory } from '@/lib/discord-directory'

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
  source: 'trending' | 'directory'
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

  // Both sources in parallel; a failure on either side degrades to an empty
  // list so one broken source never blocks the other.
  const [games, directory] = await Promise.all([
    searchTrendingGames(q, limit).catch(() => []),
    searchDiscordDirectory(q, 20),
  ])

  // Trending first (real games, ranked), then the full-directory results that
  // aren't already covered by the trending list (dedupe by App ID and name).
  const trendingIds = new Set(games.map(g => g.appId))
  const trendingNames = new Set(games.map(g => g.name.toLowerCase()))
  const directoryExtras = directory.filter(
    d => !trendingIds.has(d.appId) && !trendingNames.has(d.name.toLowerCase()),
  )

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
  ]

  return NextResponse.json({ ok: true, results })
}
