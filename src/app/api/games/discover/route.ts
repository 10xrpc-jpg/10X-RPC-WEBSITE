// 10X RPC — /api/games/discover — Game RPC search bar source.
//
// The user explicitly asked NOT to use discord.com/discovery/applications
// (its search returns mostly BOTS — "Minecraft Server Status", whitelisters,
// download tools — not actual games). Instead we search Discord's official
// TRENDING GAMES ranking (https://discord.com/trending-games/): every entry
// is a real video game with its real Discord Application ID and official
// icon, parsed from the pages' embedded JSON-LD. See lib/discord-trending.ts.
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { searchTrendingGames } from '@/lib/discord-trending'

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

  let games: Awaited<ReturnType<typeof searchTrendingGames>> = []
  try {
    games = await searchTrendingGames(q, limit)
  } catch (err) {
    console.error('[games/discover] trending games search failed:', err?.message || err)
  }

  const results: DiscoveredApp[] = games.map(g => ({
    appId: g.appId,
    name: g.name,
    iconUrl: g.iconUrl,
    coverUrl: null,
    description: 'Real game — trending on Discord',
    verified: false,
    isGame: true,
    tags: [],
  }))

  return NextResponse.json({ ok: true, results })
}
