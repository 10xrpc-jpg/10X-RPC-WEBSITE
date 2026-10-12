// 10X RPC — /api/status/toggle — Enable/Disable User Status (completely independent from RPC)
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { syncPresence } from '@/lib/presence-sync'
import { requireSubscriptionAccess } from '@/lib/subscription'
import { normalizeStatusForPlatform } from '@/lib/constants'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function POST(req: Request) {
  try {
    const session = await getSession()
    if (!session) {
      return NextResponse.json(
        { ok: false, error: 'not_authenticated' },
        { status: 401 }
      )
    }

    const body = await req.json() as { enabled?: boolean }
    const enabled = !!body.enabled

    if (enabled) {
      // 0. DISCORD LINK CHECK — enabling Status without a live Discord OAuth
      //    token would flip the DB while NOTHING changes on Discord.
      if (!session.discordAccessToken) {
        return NextResponse.json(
          { ok: false, error: 'discord_not_linked', message: 'Connect your Discord account first — click Reconnect Discord.' },
          { status: 403 }
        )
      }

      // 1. Subscription gate — trialing/active only; expired → suspended.
      const denied = await requireSubscriptionAccess(session.userId, session.user.discordId)
      if (denied) {
        return NextResponse.json(
          { ok: false, error: denied.error, message: denied.message },
          { status: 403 }
        )
      }

      // 2. Determine target status (default to 'online' if was 'invisible' or unset)
      const currentStatus = session.userStatus
      let targetStatus = (!currentStatus || currentStatus === 'invisible') ? 'online' : currentStatus

      // 2b. VR/MOBILE BADGE FIX: Discord hides the Mobile/VR platform badge
      // while the presence status is idle/dnd, so enabling Status with a badge
      // platform active would show no icon. Auto-switch Idle/DND to Online so
      // the selected Mobile/VR icon displays immediately.
      const autoOnline = targetStatus !== 'online' &&
        normalizeStatusForPlatform(session.statusPlatform || 'mobile', targetStatus, !!session.vrStatusActive) === 'online'
      if (autoOnline) targetStatus = 'online'

      // 3. Update status state in DB — strictly NO changes to rpcEnabled or rpcConfig
      await db.session.updateMany({
        where: { userId: session.userId },
        data: {
          statusEnabled: true,
          userStatus: targetStatus,
          gatewayReady: true,
          lastPresenceUpdate: new Date(),
        },
      })

      // 4. Sync Gateway Daemon immediately
      if (session.discordAccessToken) {
        await syncPresence(session.userId)
      }

      return NextResponse.json({
        ok: true,
        statusEnabled: true,
        userStatus: targetStatus,
        autoOnline,
        message: autoOnline
          ? 'Status enabled — switched to Online so your Mobile/VR badge shows'
          : 'Status enabled (Online on Discord)',
      })
    } else {
      // 1. Disable status state in DB — strictly NO changes to rpcEnabled or rpcConfig
      await db.session.updateMany({
        where: { userId: session.userId },
        data: {
          statusEnabled: false,
          lastPresenceUpdate: new Date(),
        },
      })

      // 2. Sync Gateway Daemon (if RPC is still on, RPC keeps running; if RPC is off, socket cleans up)
      if (session.discordAccessToken) {
        await syncPresence(session.userId)
      }

      return NextResponse.json({
        ok: true,
        statusEnabled: false,
        userStatus: session.userStatus,
        message: 'Status disabled (Offline)',
      })
    }
  } catch (e: any) {
    console.error('Error in /api/status/toggle:', e)
    return NextResponse.json({
      ok: false,
      error: 'toggle_failed',
      message: e?.message || 'Failed to toggle status',
    }, { status: 500 })
  }
}
