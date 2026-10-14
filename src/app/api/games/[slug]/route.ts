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
import { advanceGameRotation, takeOverGameRotation } from '@/lib/game-rotate-settings'
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
  // SINGLE-ACTIVE GAME (Task 95) — only ONE Game RPC can be active at a
  // time. Enabling a game AUTOMATICALLY disables every other enabled game
  // (atomic transaction — no double-active window). This endpoint NEVER
  // writes to RpcConfig (Normal RPC stays untouched & remembered), and
  // /api/rpc/* never writes to GameConfig. Only enabled FLAGS flip — no
  // field data is ever copied, merged, overwritten or reset.
  //
  // GAME AUTO-ROTATE interplay (fully independent system — see
  // /api/games/rotate): a manual enable takes over as the rotation head;
  // disabling the active game while rotation is ON advances to the next
  // selected game. RpcConfig / rpcAutoRotate* are never read or written here.
  // ════════════════════════════════════════════════════════════════════

  const updated = await db.$transaction(async tx => {
    let deactivated: string[] = []
    if (enabled) {
      const previouslyOn = await tx.gameConfig.findMany({
        where: { userId: session.userId, enabled: true, gameSlug: { not: slug } },
        select: { gameName: true },
      })
      const off = await tx.gameConfig.updateMany({
        where: { userId: session.userId, enabled: true, gameSlug: { not: slug } },
        data: { enabled: false },
      })
      if (off.count > 0) {
        deactivated = previouslyOn.map(r => r.gameName)
      }
    }
    const row = await tx.gameConfig.upsert({
      where: { userId_gameSlug: { userId: session.userId, gameSlug: slug } },
      create: { userId: session.userId, gameSlug: slug, ...data },
      update: data,
    })
    return { row, deactivated }
  })

  const deactivated = updated.deactivated
  const wasEnabled = !!existing?.enabled

  if (enabled) {
    // Gamer RPC is live — master RPC flag ON and push (the single active
    // game + enabled slots are candidates; the daemon resolves sessions).
    await db.session.updateMany({
      where: { userId: session.userId },
      data: { rpcEnabled: true, lastPresenceUpdate: new Date() },
    })
    // Manual takeover — this game becomes the Game Auto-Rotate head (only
    // when the GAME rotation is ON; the helper no-ops otherwise). It NEVER
    // touches Normal RPC rotation state.
    await takeOverGameRotation(session.userId, slug).catch(() => {})
    if (session.discordAccessToken) {
      syncPresenceDetached(session.userId)
    }
  } else if (wasEnabled) {
    // Disabling the ACTIVE game while Game Auto-Rotate is ON advances the
    // rotation to the next selected game (keeps exactly one game running).
    // With rotation OFF this no-ops and the user has full manual control.
    const advanced = await advanceGameRotation(session.userId, slug, session.userId).catch(() => null)
    if (!advanced) {
      // Rotation OFF (or empty pool) — no game replaces this one; the master
      // RPC flag only goes OFF when NO candidate remains.
      const [slotsLeft, gamesLeft] = await Promise.all([
        db.rpcConfig.count({ where: { userId: session.userId, enabled: true } }),
        db.gameConfig.count({ where: { userId: session.userId, enabled: true } }),
      ])
      await db.session.updateMany({
        where: { userId: session.userId },
        data: { rpcEnabled: slotsLeft + gamesLeft > 0, lastPresenceUpdate: new Date() },
      })
    }
    if (session.discordAccessToken) {
      syncPresenceDetached(session.userId)
    }
  }

  return NextResponse.json({ ok: true, config: updated.row, deactivated })
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
    // Deleting the ACTIVE game while Game Auto-Rotate is ON advances to the
    // next selected game; otherwise no game replaces it (single-active).
    const advanced = await advanceGameRotation(session.userId, existing.gameSlug, session.userId).catch(() => null)
    if (!advanced) {
      const [slotsLeft, gamesLeft] = await Promise.all([
        db.rpcConfig.count({ where: { userId: session.userId, enabled: true } }),
        db.gameConfig.count({ where: { userId: session.userId, enabled: true } }),
      ])
      await db.session.updateMany({
        where: { userId: session.userId },
        data: { rpcEnabled: slotsLeft + gamesLeft > 0, lastPresenceUpdate: new Date() },
      })
    }
    if (session.discordAccessToken) {
      syncPresenceDetached(session.userId)
    }
  }

  return NextResponse.json({ ok: true })
}
