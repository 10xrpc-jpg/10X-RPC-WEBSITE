// 10X RPC — /api/placeholders — list all available placeholders + resolve a sample
import { NextResponse } from 'next/server'
import { PLACEHOLDER_CHEAT_SHEET, resolvePlaceholders } from '@/lib/placeholders'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json({ placeholders: PLACEHOLDER_CHEAT_SHEET })
}

export async function POST(req: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

  const body = await req.json() as { text?: string }
  const text = body.text || ''
  const globalConfig = await db.globalConfig.findUnique({ where: { userId: session.userId } })
  const resolved = await resolvePlaceholders(text, {
    timezone: globalConfig?.timezone || 'Asia/Calcutta',
    city: globalConfig?.city || undefined,
    rpcStartedAt: session.createdAt.getTime(),
  })

  return NextResponse.json({ original: text, resolved })
}
