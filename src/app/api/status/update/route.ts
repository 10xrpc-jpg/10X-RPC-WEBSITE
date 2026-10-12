// 10X RPC — /api/status/update — Save & Apply ONLY Status configuration
// Strictly independent from RPC: never modifies rpcConfig, never touches rpcEnabled, never starts RPC.
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { syncPresence } from '@/lib/presence-sync'
import { BADGE_PLATFORMS } from '@/lib/constants'

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

    if (body.statusPlatform !== undefined) {
      const platform = body.statusPlatform || 'mobile'
      updateData.statusPlatform = platform
      updateData.vrStatusActive = platform === 'meta_quest'
    }

    // ── BADGE ⇄ STATUS RESOLUTION (runs LAST — its decision wins) ───────
    // Discord hides the Mobile/VR platform badge while the presence status is
    // idle/dnd (only the moon/dash glyph renders). Two product rules resolve
    // the conflict, depending on what the user asserted in THIS update:
    //
    //   • STATUS WINS (primary rule): the user selected Idle/Do Not Disturb
    //     and updated (UPDATE button or the status dropdown) → the VR/Mobile
    //     icon is AUTOMATICALLY SAVED AS NONE (desktop) and the chosen
    //     Idle/DND status is kept exactly as selected.
    //
    //   • PLATFORM WINS: only statusPlatform changed to a badge platform
    //     (platform dropdown pick) while Idle/DND was stored → the status is
    //     switched to online so the badge displays (the VR toggle endpoint
    //     enforces the same rule for the explicit VR enable).
    const effPlatform = body.statusPlatform !== undefined
      ? (body.statusPlatform || 'mobile')
      : (session.statusPlatform || 'mobile')
    const effVr = body.statusPlatform !== undefined
      ? (body.statusPlatform === 'meta_quest')
      : !!session.vrStatusActive
    const effStatus = body.userStatus !== undefined
      ? body.userStatus
      : (session.userStatus || 'online')
    const effIsBadge = effVr || BADGE_PLATFORMS.has(effPlatform)
    const statusAsserted = body.userStatus !== undefined
    const storedIdle = session.userStatus === 'idle' || session.userStatus === 'dnd'
    const autoNone = statusAsserted && (effStatus === 'idle' || effStatus === 'dnd') && effIsBadge
    const autoOnline = !statusAsserted && effIsBadge && storedIdle
    if (autoNone) {
      // Idle/DND asserted → badge saved as None, status kept (overrides the
      // raw statusPlatform above — this block runs last on purpose).
      updateData.statusPlatform = 'desktop'
      updateData.vrStatusActive = false
    } else if (autoOnline) {
      // Badge platform asserted while Idle/DND stored → status to online.
      updateData.userStatus = 'online'
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
    // ── STATUS-NOT-UPDATING FIX: propagate the daemon sync result so the UI
    // can be honest — previously a failed daemon notify (or a lost push) was
    // reported to the user as "Status updated & synced to Discord".
    let sync: { ok: boolean; message: string } | null = null
    if (isStatusEnabled && session.discordAccessToken) {
      const presence = await syncPresence(session.userId)
      sync = { ok: !!presence?.ok, message: presence?.message || '' }
    }

    // Flags for the UI toasts:
    // autoNone  — Idle/DND asserted with a Mobile/VR badge active → icon saved as None.
    // autoOnline — badge platform asserted while Idle/DND stored → status switched to online.
    return NextResponse.json({
      ok: true,
      statusEnabled: isStatusEnabled,
      userStatus: currentSession?.userStatus || 'online',
      customStatus: currentSession?.customStatus || null,
      customStatusEmoji: currentSession?.customStatusEmoji || null,
      statusPlatform: currentSession?.statusPlatform || 'mobile',
      autoOnline,
      autoNone,
      sync,
      message: !isStatusEnabled
        ? 'Status configuration saved (Status is OFF)'
        : sync?.ok
          ? (autoNone
              ? 'Idle/DND hides the VR/Mobile badge — icon saved as None & synced'
              : autoOnline
                ? 'Mobile/VR badge needs Online — status switched to Online & synced'
                : 'Status updated & synced to Discord')
          : (autoNone
              ? 'Idle/DND hides the VR/Mobile badge — icon saved as None'
              : autoOnline
                ? 'Mobile/VR badge needs Online — status switched to Online'
                : 'Status saved — Discord sync will retry within 30s'),
    })
  } catch (e: any) {
    console.error('Error in /api/status/update:', e)
    return NextResponse.json(
      { ok: false, error: 'status_update_failed', message: e?.message || 'Failed to update status' },
      { status: 500 }
    )
  }
}
