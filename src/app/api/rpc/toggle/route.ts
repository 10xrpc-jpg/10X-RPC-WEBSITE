// 10X RPC — /api/rpc/toggle — Enable/Disable RPC (Database as Single Source of Truth)
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

      // 2. Load latest saved DB config and mark enabled with fresh timestamp
      let rpcConfig = await db.rpcConfig.findFirst({ where: { userId: session.userId } })
      if (rpcConfig) {
        rpcConfig = await db.rpcConfig.update({
          where: { id: rpcConfig.id },
          data: { enabled: true },
        })
      } else {
        rpcConfig = await db.rpcConfig.create({
          data: {
            userId: session.userId,
            name: '10X RPC',
            type: 'PLAYING',
            platform: 'desktop',
            enabled: true,
            startMinsAgo: 0,
          },
        })
      }

      // 3. Update session in DB
      await db.session.updateMany({
        where: { userId: session.userId },
        data: {
          rpcEnabled: true,
          gatewayReady: true,
          lastPresenceUpdate: new Date(),
        },
      })

      // 4. Start RPC via single managed Gateway daemon using the latest saved DB config
      if (session.discordAccessToken) {
        const daemon = ensureDaemonRunning()
        await daemon.syncUser(session.userId)
      }

      return NextResponse.json({
        ok: true,
        enabled: true,
        rpcConfig,
        message: 'RPC enabled & live on Discord',
      })
    } else {
      // 1. Stop RPC completely in DB (strictly preserves statusEnabled and status fields).
      //    The gateway is kept alive only if the user's Status feature is still active
      //    on ANY of their sessions — never because of RPC.
      const statusSession = await db.session.findFirst({
        where: {
          userId: session.userId,
          statusEnabled: true,
        },
      })
      const keepGateway = !!statusSession

      await db.session.updateMany({
        where: { userId: session.userId },
        data: {
          rpcEnabled: false,
          gatewayReady: keepGateway,
          lastPresenceUpdate: new Date(),
        },
      })

      const rpcConfig = await db.rpcConfig.findFirst({ where: { userId: session.userId } })
      let updatedRpcConfig = rpcConfig
      if (rpcConfig) {
        updatedRpcConfig = await db.rpcConfig.update({
          where: { id: rpcConfig.id },
          data: { enabled: false },
        })
      }

      // 2. Clear Discord Rich Presence completely via daemon (stops all timers & background updates)
      if (session.discordAccessToken) {
        const daemon = ensureDaemonRunning()
        await daemon.stopUserRpc(session.userId)
      }

      return NextResponse.json({
        ok: true,
        enabled: false,
        rpcConfig: updatedRpcConfig,
        message: 'RPC stopped & Rich Presence cleared from Discord',
      })
    }
  } catch (e: any) {
    console.error('Error in /api/rpc/toggle:', e)
    return NextResponse.json({
      ok: false,
      error: 'toggle_failed',
      message: e?.message || 'Failed to toggle RPC',
    }, { status: 500 })
  }
}
