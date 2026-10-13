// 10X RPC — /api/placeholders — list all available placeholders + resolve a sample
// POST accepts overrides (city/timezone/tempUnit) so the /config page can render
// a LIVE preview with unsaved values before the user hits Save.
import { NextResponse } from 'next/server'
import { PLACEHOLDER_CHEAT_SHEET, resolvePlaceholders } from '@/lib/placeholders'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json({ placeholders: PLACEHOLDER_CHEAT_SHEET })
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export async function POST(req: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

  const body = await req.json() as {
    text?: string
    city?: string | null
    timezone?: string
    tempUnit?: 'C' | 'F'
    rpcStartedAt?: number
  }
  const text = body.text || ''
  const globalConfig = await db.globalConfig.findUnique({ where: { userId: session.userId } })

  const timezone = body.timezone && isValidTimezone(body.timezone)
    ? body.timezone
    : (globalConfig?.timezone && isValidTimezone(globalConfig.timezone) ? globalConfig.timezone : 'Asia/Calcutta')
  const city = body.city !== undefined ? (body.city?.trim() || null) : (globalConfig?.city || null)
  const tempUnit = body.tempUnit === 'F' ? 'F' : (body.tempUnit === 'C' ? 'C' : (globalConfig?.tempUnit === 'F' ? 'F' : 'C'))

  const resolved = await resolvePlaceholders(text, {
    timezone,
    city: city || undefined,
    tempUnit,
    rpcStartedAt: typeof body.rpcStartedAt === 'number'
      ? body.rpcStartedAt
      : session.createdAt.getTime(),
  })

  return NextResponse.json({ original: text, resolved })
}
