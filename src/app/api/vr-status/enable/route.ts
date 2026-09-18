// 10X RPC — /api/vr-status/enable — toggle VR (Meta Quest) status
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { ensureDaemonRunning } from '@/lib/rpc-daemon'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

    const body = await req.json() as { active?: boolean }
    const active = !!body.active

    // Update session state in database (Status fields only)
    await db.session.updateMany({
      where: { userId: session.userId },
      data: {
        vrStatusActive: active,
        statusPlatform: active ? 'meta_quest' : (session.statusPlatform === 'meta_quest' ? 'mobile' : session.statusPlatform),
        lastPresenceUpdate: new Date(),
      },
    })

    // If Status is enabled and user has Discord token, sync Status to gateway
    let presenceResult: any = null
    if (session.statusEnabled && session.discordAccessToken) {
      const daemon = ensureDaemonRunning()
      presenceResult = await daemon.syncUser(session.userId)
    }

    return NextResponse.json({
      ok: true,
      vrStatusActive: active,
      result: presenceResult,
    })
  } catch (e: any) {
    console.error('Error in /api/vr-status/enable:', e)
    return NextResponse.json({
      ok: false,
      error: 'vr_toggle_failed',
      message: e?.message || 'Failed to toggle VR status',
    }, { status: 500 })
  }
}
