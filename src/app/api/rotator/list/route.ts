// 10X RPC — /api/rotator/list — list all rotator presets
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

  const presets = await db.rotatorPreset.findMany({
    where: { userId: session.userId },
    orderBy: { order: 'asc' },
  })

  return NextResponse.json({ presets })
}
