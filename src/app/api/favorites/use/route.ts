// 10X RPC — /api/favorites/use — "Use for Game RPC" (Profile Board one-click)
// Resolves a favorite into the user's live Game RPC:
//   1. Preset favorite (slug)  → target = that catalog game.
//   2. App favorite (appId)    → reuse the user's existing custom game for that
//      Application ID, or CREATE it on the spot (official name + icon are
//      fetched from Discord — the App ID is grabbed automatically).
//   3. Enables it as the Gamer RPC with full mutual exclusivity (Normal RPC
//      and every other game get disabled) and pushes via the 24/7 daemon.
// Unlike POST /api/games/[slug], enabling NEVER wipes an existing saved
// config — when a config row already exists only the enabled flag flips.
import { NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { findGame, fetchDiscordApplication, DISCORD_APP_ID_RE } from '@/lib/games'
import { syncPresenceDetached } from '@/lib/presence-sync'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

  let body: { id?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const id = (body.id ?? '').trim()
  if (!id) return NextResponse.json({ error: 'id_required' }, { status: 400 })

  const favorite = await db.favoriteGame.findUnique({ where: { id } })
  if (!favorite || favorite.userId !== session.userId) {
    return NextResponse.json({ error: 'favorite_not_found' }, { status: 404 })
  }

  // ── Resolve the target game ────────────────────────────────────────────
  const preset = favorite.slug ? findGame(favorite.slug) : null
  let targetSlug: string
  let targetName: string

  if (preset) {
    // Catalog preset game (e.g. Minecraft)
    targetSlug = preset.slug
    targetName = preset.name
  } else if (favorite.appId && DISCORD_APP_ID_RE.test(favorite.appId)) {
    // Discord application favorite — find the user's existing custom game
    // for this App ID, or auto-create it (official identity auto-fill).
    const existing = await db.gameConfig.findFirst({
      where: { userId: session.userId, appId: favorite.appId },
      orderBy: { createdAt: 'desc' },
    })
    if (existing) {
      targetSlug = existing.gameSlug
      targetName = existing.gameName
    } else {
      const official = await fetchDiscordApplication(favorite.appId)
      if (!official) return NextResponse.json({ error: 'app_not_found' }, { status: 400 })
      targetSlug = `custom-${randomBytes(8).toString('hex')}`
      targetName = official.name
      await db.gameConfig.create({
        data: {
          userId: session.userId,
          gameSlug: targetSlug,
          gameName: official.name,
          enabled: false,
          appId: favorite.appId,
          platform: 'desktop',
          largeImage: official.iconUrl,
          largeText: official.name,
          partyCurrent: 1,
          partyMax: 5,
          startMinsAgo: 0,
        },
      })
    }
  } else {
    return NextResponse.json({ error: 'favorite_unresolvable' }, { status: 400 })
  }

  // ── Enable WITHOUT wiping a saved config ───────────────────────────────
  const saved = await db.gameConfig.findUnique({
    where: { userId_gameSlug: { userId: session.userId, gameSlug: targetSlug } },
  })
  if (saved) {
    await db.gameConfig.update({ where: { id: saved.id }, data: { enabled: true } })
  } else {
    // First enable of a preset: create its row from the preset defaults.
    await db.gameConfig.create({
      data: {
        userId: session.userId,
        gameSlug: targetSlug,
        gameName: preset?.name ?? targetName,
        enabled: true,
        platform: preset?.defaultPlatform ?? 'desktop',
        state: preset?.defaultState ?? null,
        details: preset?.defaultDetails ?? null,
        largeImage: preset?.largeImage ?? null,
        largeText: preset?.largeText ?? (preset?.name ?? targetName),
        partyCurrent: preset?.defaultPartyCurrent ?? 1,
        partyMax: preset?.defaultPartyMax ?? 5,
        startMinsAgo: 0,
        endTotalMins: preset?.defaultEndTotalMins ?? null,
      },
    })
  }

  // ── Mutual exclusivity (identical semantics to POST /api/games/[slug]) ──
  await db.rpcConfig.updateMany({
    where: { userId: session.userId },
    data: { enabled: false },
  })
  await db.gameConfig.updateMany({
    where: { userId: session.userId, gameSlug: { not: targetSlug } },
    data: { enabled: false },
  })
  await db.session.updateMany({
    where: { userId: session.userId },
    data: { rpcEnabled: true, lastPresenceUpdate: new Date() },
  })
  if (session.discordAccessToken) {
    syncPresenceDetached(session.userId)
  }

  return NextResponse.json({ ok: true, slug: targetSlug, name: targetName })
}
