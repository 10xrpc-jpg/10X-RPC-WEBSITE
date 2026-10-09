// 10X RPC — Discord APP DIRECTORY search (the "show ALL results" source).
//
// The Trending Games index only covers a few hundred real games, so niche
// queries like "game rpc" or small utility apps returned nothing. Discord's
// current app-directory search endpoint (the one the Discord client itself
// uses for the App Directory search box) covers EVERY published application —
// games, launchers, rich-presence tools, everything.
//
// It accepts the BOT token as a Bearer credential, so it runs entirely
// server-side with credentials the site already has. The user's Discord
// token is never involved and never leaves the session row.

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'
const SEARCH_URL = 'https://discord.com/api/v9/application-directory/search'
const FETCH_TIMEOUT_MS = 4500

export interface DirectoryApp {
  appId: string
  name: string
  iconUrl: string | null
  description: string
  verified: boolean
  /** The directory lists it under a "Games" category. */
  isGame: boolean
}

interface DirectoryApiResult {
  results?: Array<{
    type?: number
    data?: {
      id?: string
      name?: string
      icon?: string | null
      description?: string | null
      summary?: string | null
      is_verified?: boolean
      categories?: Array<{ id?: number; name?: string }>
    }
  }>
}

/** Search Discord's full App Directory by name. Failures degrade to an empty
 * list so the trending-games results are never blocked by it. */
export async function searchDiscordDirectory(query: string, limit = 20): Promise<DirectoryApp[]> {
  const token = process.env.DISCORD_BOT_TOKEN
  const q = query.trim()
  if (!token || q.length < 2) return []

  const capped = Math.min(20, Math.max(1, limit))
  const url = `${SEARCH_URL}?query=${encodeURIComponent(q)}&limit=${capped}`

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': UA,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: 'no-store',
    })
    if (!res.ok) return []
    const data = (await res.json()) as DirectoryApiResult
    const out: DirectoryApp[] = []

    for (const r of data.results || []) {
      const d = r?.data
      const appId = String(d?.id || '').trim()
      const name = String(d?.name || '').trim()
      if (!/^\d{15,21}$/.test(appId) || !name) continue
      const isGame = (d?.categories || []).some(c => String(c?.name || '').toLowerCase() === 'games')
      const description = String(d?.description || d?.summary || '').replace(/\s+/g, ' ').trim().slice(0, 140)
      out.push({
        appId,
        name,
        iconUrl:
          typeof d?.icon === 'string' && d.icon
            ? `https://cdn.discordapp.com/app-icons/${appId}/${d.icon}.png?size=128`
            : null,
        description,
        verified: !!d?.is_verified,
        isGame,
      })
    }
    return out
  } catch {
    return []
  }
}
