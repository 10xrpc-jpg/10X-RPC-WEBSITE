// 10X RPC — /api/background — set/clear custom background image
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

  const body = await req.json() as { url?: string | null }
  const url = (body.url || '').trim()

  // Basic validation: must be a URL or null/empty
  if (url && !/^https?:\/\//i.test(url)) {
    return NextResponse.json({ error: 'invalid_url' }, { status: 400 })
  }
  if (url.length > 2048) {
    return NextResponse.json({ error: 'url_too_long' }, { status: 400 })
  }

  await db.user.update({
    where: { id: session.userId },
    data: { backgroundUrl: url || null },
  })

  return NextResponse.json({ ok: true, backgroundUrl: url || null })
}
