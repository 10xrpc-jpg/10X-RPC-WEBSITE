// 10X RPC — /api/trial — get/extend trial
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { CONFIG } from '@/lib/config'

export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

  const trial = await db.trial.findUnique({ where: { userId: session.userId } })
  if (!trial) {
    const newTrial = await db.trial.create({
      data: {
        userId: session.userId,
        startsAt: new Date(),
        endsAt: new Date(Date.now() + CONFIG.app.trialDays * 24 * 60 * 60 * 1000),
      },
    })
    return NextResponse.json({ trial: newTrial })
  }
  return NextResponse.json({ trial })
}
