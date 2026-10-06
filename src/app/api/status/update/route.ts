// 10X RPC — /api/status/update — Save & Apply ONLY Status configuration
// Strictly independent from RPC: never modifies rpcConfig, never touches rpcEnabled, never starts RPC.
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { ensureDaemonRunning } from '@/lib/rpc-daemon'

export const dynamic = 'force-dynamic'
export const maxDuration = 15

export interface StatusUpdateInput {
  userStatus?: string
  customStatus?: string | null
  customStatusEmoji?: string | null
  statusPlatform?: string
}

export async function POST(req: Request) {
  try {
    const session = await getSession()
    if (!session) {
      return NextResponse.json({ ok: false, error: 'not_authenticated' }, { status: 401 })
    }

    const body: StatusUpdateInput = await req.json()

    const updateData: Record<string, unknown> = {
      lastPresenceUpdate: new Date(),
    }

    if (body.userStatus !== undefined) {
      const validStatuses = ['online', 'idle', 'dnd', 'invisible']
      if (!validStatuses.includes(body.userStatus)) {
        return NextResponse.json(
          { ok: false, error: 'invalid_status', message: 'Status must be online, idle, dnd, or invisible' },
          { status: 400 }
        )
      }
      updateData.userStatus = body.userStatus
    }

    if (body.customStatus !== undefined) {
      const text = body.customStatus ? body.customStatus.trim() : null
      if (text && text.length > 128) {
        return NextResponse.json(
          { ok: false, error: 'invalid_text', message: 'Custom message too long (max 128 chars)' },
          { status: 400 }
        )
      }
      updateData.customStatus = text
    }

    if (body.customStatusEmoji !== undefined) {
      updateData.customStatusEmoji = body.customStatusEmoji ? body.customStatusEmoji.trim() : null
    }

    if (body.statusPlatform !== undefined) {
      const platform = body.statusPlatform || 'mobile'
      updateData.statusPlatform = platform
      updateData.vrStatusActive = platform === 'meta_quest'
    }

    // Save ONLY to Session (Status DB fields) — NEVER touch RpcConfig or rpcEnabled
    await db.session.updateMany({
      where: { userId: session.userId },
      data: updateData,
    })

    // Fetch fresh session to check statusEnabled
    const currentSession = await db.session.findUnique({ where: { id: session.id } })
    const isStatusEnabled = !!currentSession?.statusEnabled

    // If Status is ON and user is authenticated with Discord: sync Status
    // (RPC will remain in whatever state it was in; if RPC is OFF, RPC stays 100% OFF)
    if (isStatusEnabled && session.discordAccessToken) {
      const daemon = ensureDaemonRunning()
      await daemon.syncUser(session.userId)
    }

    return NextResponse.json({
      ok: true,
      statusEnabled: isStatusEnabled,
      userStatus: currentSession?.userStatus || 'online',
      customStatus: currentSession?.customStatus || null,
      customStatusEmoji: currentSession?.customStatusEmoji || null,
      statusPlatform: currentSession?.statusPlatform || 'mobile',
      message: isStatusEnabled
        ? '✓ Status updated & synced to Discord'
        : '✓ Status configuration saved (Status is OFF)',
    })
  } catch (e: any) {
    console.error('Error in /api/status/update:', e)
    return NextResponse.json(
      { ok: false, error: 'status_update_failed', message: e?.message || 'Failed to update status' },
      { status: 500 }
    )
  }
}
