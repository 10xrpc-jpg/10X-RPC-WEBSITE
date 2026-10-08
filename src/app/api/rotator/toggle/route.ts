// 10X RPC — /api/rotator/toggle — enable/disable the rotator globally
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

  const body = await req.json() as { enabled?: boolean; intervalMins?: number }
  const enabled = !!body.enabled

  const updated = await db.globalConfig.upsert({
    where: { userId: session.userId },
    create: {
      userId: session.userId,
      rotatorEnabled: enabled,
      rotatorIntervalMins: body.intervalMins ?? 5,
    },
    update: {
      rotatorEnabled: enabled,
      rotatorIntervalMins: body.intervalMins ?? 5,
    },
  })

  return NextResponse.json({ ok: true, globalConfig: updated })
}
