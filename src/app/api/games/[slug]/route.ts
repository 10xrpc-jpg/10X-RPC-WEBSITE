// 10X RPC — /api/games/[slug] — GET/POST per-game RPC config
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { findGame } from '@/lib/games'
import { ensureDaemonRunning } from '@/lib/rpc-daemon'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params
  const preset = findGame(slug)
  if (!preset) return NextResponse.json({ error: 'game_not_found' }, { status: 404 })

  const session = await getSession()
  const userId = session?.userId
  const saved = userId
    ? await db.gameConfig.findUnique({ where: { userId_gameSlug: { userId, gameSlug: slug } } })
    : null

  return NextResponse.json({
    preset,
    config: saved ?? null,
  })
}

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params
  const preset = findGame(slug)
  if (!preset) return NextResponse.json({ error: 'game_not_found' }, { status: 404 })

  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

  const body = await req.json()
  const enabled = body.enabled ?? false
  const data = {
    gameName: preset.name,
    enabled,
    platform: body.platform ?? preset.defaultPlatform,
    state: body.state ?? null,
    details: body.details ?? null,
    largeImage: body.largeImage ?? preset.largeImage,
    largeText: body.largeText ?? preset.largeText,
    smallImage: body.smallImage ?? null,
    smallText: body.smallText ?? null,
    button1Label: body.button1Label ?? null,
    button1Url: body.button1Url ?? null,
    button2Label: body.button2Label ?? null,
    button2Url: body.button2Url ?? null,
    partyCurrent: typeof body.partyCurrent === 'number' ? body.partyCurrent : preset.defaultPartyCurrent,
    partyMax: typeof body.partyMax === 'number' ? body.partyMax : preset.defaultPartyMax,
    partyId: body.partyId ?? null,
    partySecret: body.partySecret ?? null,
    startMinsAgo: typeof body.startMinsAgo === 'number' ? body.startMinsAgo : 0,
    endTotalMins: typeof body.endTotalMins === 'number' ? body.endTotalMins : null,
  }

  // If enabled, disable other games
  if (enabled) {
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

  // If enabled, sync to active RpcConfig and trigger 24/7 daemon
  if (enabled) {
    const rpcData = {
      name: data.gameName,
      type: 'PLAYING',
      platform: data.platform,
      state: data.state,
      details: data.details,
      largeImage: data.largeImage,
      largeText: data.largeText,
      smallImage: data.smallImage,
      smallText: data.smallText,
      button1Label: data.button1Label,
      button1Url: data.button1Url,
      button2Label: data.button2Label,
      button2Url: data.button2Url,
      partyCurrent: data.partyCurrent,
      partyMax: data.partyMax,
      partyId: data.partyId,
      partySecret: data.partySecret,
      startMinsAgo: data.startMinsAgo,
      endTotalMins: data.endTotalMins,
      enabled: true,
    }
    const existingRpc = await db.rpcConfig.findFirst({ where: { userId: session.userId } })
    if (existingRpc) {
      await db.rpcConfig.update({ where: { id: existingRpc.id }, data: rpcData })
    } else {
      await db.rpcConfig.create({ data: { userId: session.userId, ...rpcData } })
    }
    await db.session.update({ where: { id: session.id }, data: { rpcEnabled: true } })
    ensureDaemonRunning().syncUser(session.userId).catch(() => {})
  }

  return NextResponse.json({ ok: true, config: updated })
}
