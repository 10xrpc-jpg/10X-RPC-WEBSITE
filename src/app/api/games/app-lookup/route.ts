// 10X RPC — /api/games/app-lookup — resolve a Discord Application ID to its
// official identity (name + icon) for the "Add Games" dialog auto-fill.
// Proxied server-side to avoid CORS and keep the client payload tiny.
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { fetchDiscordApplication, DISCORD_APP_ID_RE } from '@/lib/games'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const appId = (searchParams.get('appId') || '').trim()
  if (!DISCORD_APP_ID_RE.test(appId)) {
    return NextResponse.json({ error: 'invalid_app_id' }, { status: 400 })
  }

  const identity = await fetchDiscordApplication(appId)
  if (!identity) {
    return NextResponse.json({ error: 'app_not_found' }, { status: 404 })
  }

  return NextResponse.json({ ok: true, name: identity.name, iconUrl: identity.iconUrl })
}
