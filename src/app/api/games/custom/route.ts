// 10X RPC — /api/games/custom — POST create a custom game (the "Add Games" button)
// Games are added by their Discord Application ID: the official identity (name
// + icon) is fetched from Discord and stored as the GameConfig row (gameSlug
// gets a "custom-" prefix; the row is both the catalog entry and the config).
// The daemon presents the presence as THAT application (official
// application_id + name + icon).
import { NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { fetchDiscordApplication, DISCORD_APP_ID_RE } from '@/lib/games'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

  let body: { name?: string; details?: string; iconUrl?: string; appId?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const name = (body.name ?? '').trim()
  const details = (body.details ?? '').trim()
  const iconUrl = (body.iconUrl ?? '').trim()
  const appId = (body.appId ?? '').trim()

  // Application ID is required: it is the identity of the added game.
  if (!appId) return NextResponse.json({ error: 'app_id_required' }, { status: 400 })

  // Validate format AND existence via Discord's public API. The official
  // identity (name + icon) always wins — that is the whole point of adding a
  // game by Application ID.
  let officialName: string | null = null
  let officialIcon: string | null = null
  if (appId) {
    if (!DISCORD_APP_ID_RE.test(appId)) {
      return NextResponse.json({ error: 'invalid_app_id' }, { status: 400 })
    }
    const official = await fetchDiscordApplication(appId)
    if (!official) {
      return NextResponse.json({ error: 'app_not_found' }, { status: 400 })
    }
    officialName = official.name
    officialIcon = official.iconUrl
  }

  const gameSlug = `custom-${randomBytes(8).toString('hex')}`

  const created = await db.gameConfig.create({
    data: {
      userId: session.userId,
      gameSlug,
      gameName: officialName || name,
      enabled: false,
      appId: appId || null,
      platform: 'desktop',
      state: null,
      details: details || null,
      largeImage: officialIcon || iconUrl || null,
      largeText: officialName || name,
      partyCurrent: 1,
      partyMax: 5,
      startMinsAgo: 0,
      endTotalMins: null,
    },
  })

  return NextResponse.json({ ok: true, config: created })
}
