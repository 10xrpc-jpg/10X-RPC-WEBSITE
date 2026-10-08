// 10X RPC — /api/favorites — Profile Board "Favorite Game" list
// GET    → the user's favorite games (newest first)
// POST   → add/favorite a game { name, appId?, slug?, iconUrl? }
//          • appId  = a Discord application found via the directory search
//          • slug   = a catalog preset game (e.g. "minecraft")
// DELETE → ?id=<favoriteId> removes one favorite
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { findGame, fetchDiscordApplication, DISCORD_APP_ID_RE } from '@/lib/games'

export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

  const favorites = await db.favoriteGame.findMany({
    where: { userId: session.userId },
    orderBy: { createdAt: 'desc' },
  })

  return NextResponse.json({ ok: true, favorites })
}

export async function POST(req: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

  let body: { name?: string; appId?: string; slug?: string; iconUrl?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const appId = (body.appId ?? '').trim() || null
  const slug = (body.slug ?? '').trim() || null
  const iconUrl = (body.iconUrl ?? '').trim() || null

  // Resolve the official name: explicit name → preset name → app lookup.
  let name = (body.name ?? '').trim()
  if (!name && slug) {
    name = findGame(slug)?.name ?? ''
  }
  if (!name && appId) {
    if (!DISCORD_APP_ID_RE.test(appId)) {
      return NextResponse.json({ error: 'invalid_app_id' }, { status: 400 })
    }
    const official = await fetchDiscordApplication(appId)
    if (!official) return NextResponse.json({ error: 'app_not_found' }, { status: 400 })
    name = official.name
  }
  if (!name) return NextResponse.json({ error: 'name_required' }, { status: 400 })

  const favorite = await db.favoriteGame.upsert({
    where: { userId_name: { userId: session.userId, name } },
    create: { userId: session.userId, name, appId, slug, iconUrl },
    update: {
      // Identity fields are written EXPLICITLY (null clears) — appId and
      // slug are mutually exclusive identities and a stale value left behind
      // by an earlier favorite must never win during /api/favorites/use
      // resolution. Icon stays fresh too (may have been null on first add).
      appId,
      slug,
      iconUrl,
    },
  })

  return NextResponse.json({ ok: true, favorite })
}

export async function DELETE(req: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

  const id = new URL(req.url).searchParams.get('id')?.trim()
  if (!id) return NextResponse.json({ error: 'id_required' }, { status: 400 })

  const existing = await db.favoriteGame.findUnique({ where: { id } })
  if (!existing || existing.userId !== session.userId) {
    return NextResponse.json({ error: 'favorite_not_found' }, { status: 404 })
  }

  await db.favoriteGame.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
