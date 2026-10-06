// 10X RPC — /api/status/toggle — Enable/Disable User Status (completely independent from RPC)
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { ensureDaemonRunning } from '@/lib/rpc-daemon'

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
      // 1. Check trial
      const trial = await db.trial.findUnique({ where: { userId: session.userId } })
      if (!trial || !trial.active || trial.endsAt < new Date()) {
        return NextResponse.json(
          { ok: false, error: 'trial_expired', message: 'Your 3-day trial has expired.' },
          { status: 403 }
        )
      }

      // 2. Determine target status (default to 'online' if was 'invisible' or unset)
      const currentStatus = session.userStatus
      const targetStatus = (!currentStatus || currentStatus === 'invisible') ? 'online' : currentStatus

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
        const daemon = ensureDaemonRunning()
        await daemon.syncUser(session.userId)
      }

      return NextResponse.json({
        ok: true,
        statusEnabled: true,
        userStatus: targetStatus,
        message: 'Status enabled (Online on Discord)',
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
        const daemon = ensureDaemonRunning()
        await daemon.syncUser(session.userId)
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
