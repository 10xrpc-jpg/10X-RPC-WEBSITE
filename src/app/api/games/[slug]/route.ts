// 10X RPC — /api/games/[slug] — GET/POST/DELETE per-game RPC config
// Preset games resolve through GAME_PRESETS. Custom games ("Add Games", slug
// starts with "custom-") resolve from the user's own GameConfig row, which is
// both their catalog entry and their config.
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { findGame, fetchDiscordApplication, DISCORD_APP_ID_RE } from '@/lib/games'
import { syncPresenceDetached } from '@/lib/presence-sync'
import { capStr, capNum, LIMIT_TEXT, LIMIT_ASSET_REF, LIMIT_URL, LIMIT_SHORT } from '@/lib/validate'
import type { GameConfig as DbGameConfig } from '@prisma/client'

export const dynamic = 'force-dynamic'

const isCustomSlug = (slug: string) => slug.startsWith('custom-')

/** Build a preset-shaped object from a saved custom-game row. */
function customPreset(row: DbGameConfig) {
  return {
    slug: row.gameSlug,
    name: row.gameName,
    largeImage: row.largeImage || '',
    largeText: row.gameName,
    defaultState: row.state || '',
    defaultDetails: row.details || 'Custom Game',
    defaultPlatform: row.platform || 'desktop',
    defaultPartyMax: row.partyMax || 5,
    defaultPartyCurrent: row.partyCurrent || 1,
    defaultEndTotalMins: null as number | null,
    tags: [] as string[],
    appId: row.appId,
    custom: true,
  }
}

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params
  const preset = findGame(slug)
  if (!preset && !isCustomSlug(slug)) {
    return NextResponse.json({ error: 'game_not_found' }, { status: 404 })
  }

  const session = await getSession()
  const userId = session?.userId
  const saved = userId
    ? await db.gameConfig.findUnique({ where: { userId_gameSlug: { userId, gameSlug: slug } } })
    : null

  if (!preset) {
    // Custom game: the saved row IS the game. No row → it doesn't exist.
    if (!saved) return NextResponse.json({ error: 'game_not_found' }, { status: 404 })
    return NextResponse.json({ preset: customPreset(saved), config: saved })
  }

  return NextResponse.json({ preset, config: saved ?? null })
}

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params
  const preset = findGame(slug)
  if (!preset && !isCustomSlug(slug)) {
    return NextResponse.json({ error: 'game_not_found' }, { status: 404 })
  }

  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

  const existing = await db.gameConfig.findUnique({
    where: { userId_gameSlug: { userId: session.userId, gameSlug: slug } },
  })
  if (!preset && !existing) {
    return NextResponse.json({ error: 'game_not_found' }, { status: 404 })
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const enabled = (body as { enabled?: boolean }).enabled ?? false

  // Custom games may carry a Discord Application ID ("Add Games"). Semantics:
  //   body.appId undefined → keep the stored value
  //   body.appId ''        → clear it (game falls back to the 10X identity)
  //   body.appId digits    → validate against Discord; official name + icon win
  let appId: string | null | undefined
  let officialName: string | null = null
  let officialIcon: string | null = null
  if (!preset && body.appId !== undefined) {
    const raw = String(body.appId ?? '').trim()
    if (raw === '') {
      appId = null
    } else if (DISCORD_APP_ID_RE.test(raw)) {
      const official = await fetchDiscordApplication(raw)
      if (!official) {
        return NextResponse.json({ error: 'app_not_found' }, { status: 400 })
      }
      appId = raw
      officialName = official.name
      officialIcon = official.iconUrl
    } else {
      return NextResponse.json({ error: 'invalid_app_id' }, { status: 400 })
    }
  }

  const data = {
    gameName: preset ? preset.name : (officialName ?? (existing as DbGameConfig).gameName),
    enabled,
    appId: preset ? undefined : (appId ?? (existing as DbGameConfig).appId),
    platform: capStr(body.platform, 32) ?? preset?.defaultPlatform ?? 'desktop',
    state: capStr(body.state, LIMIT_TEXT),
    details: capStr(body.details, LIMIT_TEXT),
    largeImage: officialIcon ?? capStr(body.largeImage, LIMIT_ASSET_REF) ?? preset?.largeImage ?? (existing as DbGameConfig).largeImage,
    largeText: capStr(body.largeText, LIMIT_TEXT) ?? preset?.largeText ?? (existing as DbGameConfig).gameName,
    smallImage: capStr(body.smallImage, LIMIT_ASSET_REF),
    smallText: capStr(body.smallText, LIMIT_TEXT),
    button1Label: capStr(body.button1Label, LIMIT_SHORT),
    button1Url: capStr(body.button1Url, LIMIT_URL),
    button2Label: capStr(body.button2Label, LIMIT_SHORT),
    button2Url: capStr(body.button2Url, LIMIT_URL),
    partyCurrent: capNum(body.partyCurrent, 0, 9999) ?? preset?.defaultPartyCurrent ?? 1,
    partyMax: capNum(body.partyMax, 0, 9999) ?? preset?.defaultPartyMax ?? 5,
    partyId: capStr(body.partyId, LIMIT_SHORT),
    partySecret: capStr(body.partySecret, LIMIT_SHORT),
    startMinsAgo: capNum(body.startMinsAgo, 0, 10080) ?? 0,
    endTotalMins: capNum(body.endTotalMins, 0, 10080),
  }

  // ════════════════════════════════════════════════════════════════════
  // MUTUAL EXCLUSIVITY — Normal RPC and Gamer RPC are COMPLETELY SEPARATE
  // configurations. Enabling Gamer RPC must automatically disable Normal RPC,
  // and vice versa. This endpoint NEVER writes to RpcConfig (the Normal RPC
  // config stays untouched & remembered), and /api/rpc/* never writes to
  // GameConfig. Only enabled FLAGS flip — no field data is ever copied,
  // merged, overwritten or reset between the two modes.
  // ════════════════════════════════════════════════════════════════════
  if (enabled) {
    // GAMER RPC ON → NORMAL RPC OFF (auto-disable Normal's own enabled flag;
    // its saved fields stay untouched for when the user switches back).
    await db.rpcConfig.updateMany({
      where: { userId: session.userId },
      data: { enabled: false },
    })
    // Single-active-game invariant: only this game may stay enabled.
    await db.gameConfig.updateMany({
      where: { userId: session.userId, gameSlug: { not: slug } },
      data: { enabled: false },
    })
  }

  const updated = await db.gameConfig.upsert({
    where: { userId_gameSlug: { userId: session.userId, gameSlug: slug } },
    create: { userId: session.userId, gameSlug: slug, ...data },
    update: data,
  })

  if (enabled) {
    // Gamer RPC is now the active mode — master RPC flag ON and push the
    // GAME's OWN config (no RpcConfig copy involved).
    await db.session.updateMany({
      where: { userId: session.userId },
      data: { rpcEnabled: true, lastPresenceUpdate: new Date() },
    })
    if (session.discordAccessToken) {
      syncPresenceDetached(session.userId)
    }
  } else if (existing?.enabled) {
    // Disabling the currently-enabled game turns Gamer RPC off. By mutual
    // exclusivity Normal RPC was already disabled, so the master RPC flag
    // goes OFF too (daemon clears the presence; neither config is touched).
    await db.session.updateMany({
      where: { userId: session.userId },
      data: { rpcEnabled: false, lastPresenceUpdate: new Date() },
    })
    if (session.discordAccessToken) {
      syncPresenceDetached(session.userId)
    }
  }

  return NextResponse.json({ ok: true, config: updated })
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params
  if (!isCustomSlug(slug)) {
    // Preset games are part of the catalog and cannot be deleted.
    return NextResponse.json({ error: 'cannot_delete_preset' }, { status: 400 })
  }

  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

  const existing = await db.gameConfig.findUnique({
    where: { userId_gameSlug: { userId: session.userId, gameSlug: slug } },
  })
  if (!existing) return NextResponse.json({ error: 'game_not_found' }, { status: 404 })

  await db.gameConfig.delete({
    where: { userId_gameSlug: { userId: session.userId, gameSlug: slug } },
  })

  if (existing.enabled) {
    // Deleting the currently-enabled game turns Gamer RPC off completely.
    // Normal RPC stays exactly as it was (disabled — mutual exclusivity).
    await db.session.updateMany({
      where: { userId: session.userId },
      data: { rpcEnabled: false, lastPresenceUpdate: new Date() },
    })
    if (session.discordAccessToken) {
      syncPresenceDetached(session.userId)
    }
  }

  return NextResponse.json({ ok: true })
}
