// 10X RPC — /api/rotator/save — create or update a preset
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { MAX_ROTATOR_PRESETS } from '@/lib/rotator'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

  const body = await req.json() as {
    id?: string
    emoji?: string | null
    text?: string
    durationMins?: number
    enabled?: boolean
  }

  const text = (body.text || '').trim()
  if (!text) return NextResponse.json({ error: 'text_required' }, { status: 400 })
  if (text.length > 128) return NextResponse.json({ error: 'text_too_long' }, { status: 400 })

  const count = await db.rotatorPreset.count({ where: { userId: session.userId } })
  if (!body.id && count >= MAX_ROTATOR_PRESETS) {
    return NextResponse.json({ error: 'max_presets_reached', max: MAX_ROTATOR_PRESETS }, { status: 400 })
  }

  if (body.id) {
    const updated = await db.rotatorPreset.update({
      where: { id: body.id, userId: session.userId },
      data: {
        emoji: body.emoji ?? null,
        text,
        durationMins: body.durationMins ?? 5,
        enabled: body.enabled ?? true,
      },
    })
    return NextResponse.json({ ok: true, preset: updated })
  }

  const created = await db.rotatorPreset.create({
    data: {
      userId: session.userId,
      emoji: body.emoji ?? null,
      text,
      durationMins: body.durationMins ?? 5,
      order: count,
      enabled: body.enabled ?? true,
    },
  })
  return NextResponse.json({ ok: true, preset: created })
}

export async function DELETE(req: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })
  const url = new URL(req.url)
  const id = url.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id_required' }, { status: 400 })

  await db.rotatorPreset.deleteMany({ where: { id, userId: session.userId } })
  return NextResponse.json({ ok: true })
}
