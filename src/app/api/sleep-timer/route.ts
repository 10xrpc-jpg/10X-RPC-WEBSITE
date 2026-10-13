// 10X RPC — /api/sleep-timer — set or clear the smart sleep timer
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

  const body = await req.json() as { hours?: number | null }
  if (body.hours == null) {
    // Clear timer
    await db.session.update({
      where: { id: session.id },
      data: { sleepTimerActive: false, sleepTimerEndsAt: null },
    })
    return NextResponse.json({ ok: true, active: false })
  }

  const hours = Number(body.hours)
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 7) {
    return NextResponse.json({ error: 'invalid_hours' }, { status: 400 })
  }

  const endsAt = new Date(Date.now() + hours * 60 * 60 * 1000)
  await db.session.update({
    where: { id: session.id },
    data: { sleepTimerActive: true, sleepTimerEndsAt: endsAt },
  })

  return NextResponse.json({ ok: true, active: true, endsAt })
}
