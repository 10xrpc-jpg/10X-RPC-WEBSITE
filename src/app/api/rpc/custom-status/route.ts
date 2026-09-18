// 10X RPC — /api/rpc/custom-status — set custom Discord status via 24/7 Gateway
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { ensureDaemonRunning } from '@/lib/rpc-daemon'

export const dynamic = 'force-dynamic'
export const maxDuration = 15

export async function POST(req: Request) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ ok: false, error: 'not_authenticated' }, { status: 401 })
  }

  const body = await req.json() as { emoji?: string | null; text?: string | null }
  const emoji = body.emoji?.trim() || null
  const text = body.text?.trim() || null

  // Persist to session
  await db.session.update({
    where: { id: session.id },
    data: {
      customStatus: text,
      customStatusEmoji: emoji,
    },
  })

  // If we have a Discord access token and Status is enabled, push immediately to Gateway
  if (session.statusEnabled && session.discordAccessToken) {
    const daemon = ensureDaemonRunning()
    await daemon.syncUser(session.userId)

    return NextResponse.json({
      ok: true,
      customStatus: { emoji, text },
      message: text ? `Custom status set: ${emoji || ''} ${text}` : 'Custom status cleared',
    })
  }

  // Demo mode — just persisted to DB
  return NextResponse.json({
    ok: true,
    customStatus: { emoji, text },
    message: 'Saved (demo mode — sign in with Discord to apply to Discord)',
  })
}
