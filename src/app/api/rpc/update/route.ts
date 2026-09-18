// 10X RPC — /api/rpc/update — Push latest saved DB config to Discord Gateway
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { ensureDaemonRunning } from '@/lib/rpc-daemon'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function POST() {
  try {
    const session = await getSession()
    if (!session) {
      return NextResponse.json(
        { ok: false, error: 'not_authenticated' },
        { status: 401 }
      )
    }

    // Check trial
    const trial = await db.trial.findUnique({ where: { userId: session.userId } })
    if (!trial || !trial.active || trial.endsAt < new Date()) {
      return NextResponse.json(
        { ok: false, error: 'trial_expired', message: 'Your 3-day trial has expired.' },
        { status: 403 }
      )
    }

    // Load RPC config from DB (Single Source of Truth)
    let rpcConfig = await db.rpcConfig.findFirst({ where: { userId: session.userId } })
    if (!rpcConfig) {
      rpcConfig = await db.rpcConfig.create({
        data: {
          userId: session.userId,
          name: '10X RPC',
          type: 'PLAYING',
          platform: 'desktop',
          enabled: false,
          startMinsAgo: 0,
        },
      })
    }

    // CRITICAL: UPDATE must NEVER automatically enable RPC!
    // RPC only runs if already enabled via the dedicated ENABLE RPC toggle.
    const isRpcEnabled = !!(session.rpcEnabled && rpcConfig.enabled)

    if (!isRpcEnabled) {
      return NextResponse.json({
        ok: true,
        rpcConfig,
        rpcEnabled: false,
        message: 'Configuration saved (RPC is OFF)',
      })
    }

    // Update session timestamp in DB without touching status fields
    await db.session.updateMany({
      where: { userId: session.userId },
      data: {
        lastPresenceUpdate: new Date(),
      },
    })

    // Sync Gateway on the single managed persistent socket
    if (session.discordAccessToken) {
      const daemon = ensureDaemonRunning()
      await daemon.syncUser(session.userId)
    }

    return NextResponse.json({
      ok: true,
      rpcConfig,
      rpcEnabled: true,
      gatewayReady: true,
      message: 'Rich Presence updated & live on Discord',
    })
  } catch (e: any) {
    console.error('Error updating presence:', e)
    return NextResponse.json({
      ok: false,
      error: 'update_failed',
      message: e?.message || 'Failed to update presence',
    }, { status: 500 })
  }
}
