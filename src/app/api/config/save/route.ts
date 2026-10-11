// 10X RPC — /api/config/save — save global config (city, timezone, tempUnit)
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

  const body = await req.json() as { city?: string; timezone?: string; tempUnit?: string }
  const city = body.city?.trim() || null
  const timezone = body.timezone?.trim() || 'Asia/Calcutta'
  const tempUnit = body.tempUnit === 'F' ? 'F' : 'C'

  const updated = await db.globalConfig.upsert({
    where: { userId: session.userId },
    create: { userId: session.userId, city, timezone, tempUnit },
    update: { city, timezone, tempUnit },
  })

  return NextResponse.json({ ok: true, globalConfig: updated })
}
