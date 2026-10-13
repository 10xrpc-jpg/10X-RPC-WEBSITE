// 10X RPC — /api/vr-status/enable — toggle VR (Meta Quest) status
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { syncPresence } from '@/lib/presence-sync'
import { normalizeStatusForPlatform } from '@/lib/constants'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

    const body = await req.json() as { active?: boolean }
    const active = !!body.active

    // Update session state in database (Status fields only)
    const data: Record<string, unknown> = {
      vrStatusActive: active,
      statusPlatform: active ? 'meta_quest' : (session.statusPlatform === 'meta_quest' ? 'mobile' : session.statusPlatform),
      lastPresenceUpdate: new Date(),
    }

    // ── VR BADGE FIX: Discord hides the VR headset badge while the presence
    // status is idle/dnd, so "Idle + VR" looked like "the icon is not
    // showing". Enabling VR automatically switches Idle/DND to Online so the
    // headset icon always displays immediately.
    const requested = session.userStatus || 'online'
    const storedStatus = active
      ? normalizeStatusForPlatform('meta_quest', requested)
      : requested
    if (storedStatus !== requested) {
      data.userStatus = storedStatus
    }
    const autoOnline = storedStatus !== requested

    await db.session.updateMany({
      where: { userId: session.userId },
      data,
    })

    // If Status is enabled and user has Discord token, sync Status to gateway
    let presenceResult: any = null
    if (session.statusEnabled && session.discordAccessToken) {
      presenceResult = await syncPresence(session.userId)
    }

    return NextResponse.json({
      ok: true,
      vrStatusActive: active,
      userStatus: storedStatus,
      autoOnline,
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
