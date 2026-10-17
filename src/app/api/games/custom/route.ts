// 10X RPC — /api/games/custom — POST create a custom game (the "Add Games" button)
// Games are added by their Discord Application ID: the official identity (name
// + icon) is fetched from Discord and stored as the GameConfig row (gameSlug
// gets a "custom-" prefix; the row is both the catalog entry and the config).
// The daemon presents the presence as THAT application (official
// application_id + name + icon).
//
// DUPLICATE PROTECTION (self-heal for the historical "Counter-Strike 2 twice"
// bug): an add is IDEMPOTENT at three levels —
//   1. same Application ID          → return the existing row;
//   2. Application ID of a CATALOG preset (GAME_SPOOF map) → upsert/return
//      the preset row instead of creating a custom duplicate;
//   3. official name already owned by the user (case-insensitive, preset or
//      custom) → return that row.
// In every "already exists" case the response carries existing: true so the
// UI can navigate to the game instead of reporting a fresh creation.
import { NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import {
  fetchDiscordApplication,
  findGameByAppId,
  findGameByName,
  gamePresetDefaults,
  DISCORD_APP_ID_RE,
} from '@/lib/games'

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

  if (!DISCORD_APP_ID_RE.test(appId)) {
    return NextResponse.json({ error: 'invalid_app_id' }, { status: 400 })
  }

  // ── Idempotent add (1): this user already added a game with this App ID.
  const existingByAppId = await db.gameConfig.findFirst({
    where: { userId: session.userId, appId },
    orderBy: { createdAt: 'desc' },
  })
  if (existingByAppId) {
    return NextResponse.json({ ok: true, config: existingByAppId, existing: true })
  }

  // ── Idempotent add (2): the App ID IS a catalog preset's official identity
  // (e.g. the real Counter-Strike 2 application). Map onto the preset row —
  // never create a "custom" twin of a game the catalog already offers.
  const presetByAppId = findGameByAppId(appId)
  if (presetByAppId) {
    const defaults = gamePresetDefaults(presetByAppId.slug)!
    const row = await db.gameConfig.upsert({
      where: { userId_gameSlug: { userId: session.userId, gameSlug: presetByAppId.slug } },
      create: { userId: session.userId, ...defaults },
      update: {},
    })
    return NextResponse.json({ ok: true, config: row, existing: true })
  }

  // Official identity always wins — that is the whole point of adding a
  // game by Application ID.
  const official = await fetchDiscordApplication(appId)
  if (!official) {
    return NextResponse.json({ error: 'app_not_found' }, { status: 400 })
  }

  // ── Idempotent add (3): the official name matches a CATALOG preset
  // (case-insensitive) or a game this user already owns. Return the existing
  // row instead of creating a same-name duplicate (duplicate names showed up
  // twice in the Game Auto-Rotate pool picker).
  const presetByName = findGameByName(official.name)
  if (presetByName) {
    const defaults = gamePresetDefaults(presetByName.slug)!
    const row = await db.gameConfig.upsert({
      where: { userId_gameSlug: { userId: session.userId, gameSlug: presetByName.slug } },
      create: { userId: session.userId, ...defaults },
      update: {},
    })
    return NextResponse.json({ ok: true, config: row, existing: true })
  }
  const ownedRows = await db.gameConfig.findMany({
    where: { userId: session.userId },
    select: { gameSlug: true, gameName: true },
    orderBy: { createdAt: 'asc' },
  })
  const norm = official.name.trim().toLowerCase()
  const nameDup = ownedRows.find(r => (r.gameName || '').trim().toLowerCase() === norm)
  if (nameDup) {
    // Stamp the App ID onto the existing row so future adds of this exact
    // application short-circuit at check (1).
    const row = await db.gameConfig
      .update({
        where: { userId_gameSlug: { userId: session.userId, gameSlug: nameDup.gameSlug } },
        data: { appId },
      })
      .catch(() => null)
    return NextResponse.json({
      ok: true,
      config: row ?? nameDup,
      existing: true,
      duplicate: true,
    })
  }

  const gameSlug = `custom-${randomBytes(8).toString('hex')}`

  const created = await db.gameConfig.create({
    data: {
      userId: session.userId,
      gameSlug,
      gameName: official.name || name,
      enabled: false,
      appId,
      platform: 'desktop',
      state: null,
      details: details || null,
      largeImage: official.iconUrl || iconUrl || null,
      largeText: official.name || name,
      partyCurrent: 1,
      partyMax: 5,
      startMinsAgo: 0,
      endTotalMins: null,
    },
  })

  return NextResponse.json({ ok: true, config: created })
}
