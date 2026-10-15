// 10X RPC — /api/status/update — Save & Apply ONLY Status configuration
// Strictly independent from RPC: never modifies rpcConfig, never touches rpcEnabled, never starts RPC.
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { syncPresenceVerified } from '@/lib/presence-sync'
import { BADGE_PLATFORMS } from '@/lib/constants'
import { patchDiscordAccountSettings } from '@/lib/discord-settings'

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
    let sync: { ok: boolean; applied?: boolean; message: string } | null = null
    if (isStatusEnabled && session.discordAccessToken) {
      // Task 99 — verified sync: the daemon confirms whether the running
      // state now MATCHES the saved configuration (and retries itself until
      // it does when a re-identify handshake is still in flight).
      const presence = await syncPresenceVerified(session.userId)
      sync = { ok: !!presence?.ok, applied: presence?.applied, message: presence?.message || '' }
    }

    // ── ACCOUNT-STATUS PATCH (the "Online/Idle/DND not working" fix) ──────
    // Live-verified 2026-10-15: Discord's gateways IGNORE the `status` field
    // of OP 3 presence updates for OAuth/sdk sessions — the profile status is
    // pinned to the ACCOUNT-level user_settings.status. The honored path is
    // REST PATCH /users/@me/settings (what the real client does), which our
    // OAuth token is authorized for. Without this, the first Idle/DND pick
    // sticks forever and every later pick silently does nothing (and the
    // Mobile/VR badges stay hidden because Discord hides them while the
    // account status is idle/dnd).
    // Runs whenever Status is enabled and we hold a Discord token — right
    // after the save, BEFORE the daemon notify (the daemon self-heals too,
    // but this makes the change instant).
    // The custom status text/emoji lives in the same account settings
    // (user_settings.custom_status) — patch it whenever this update carries
    // one, so the Custom Msg + emoji feature actually renders on Discord.
    let accountSync: { ok: boolean; error?: string } | null = null
    if (isStatusEnabled && session.discordAccessToken && currentSession) {
      const patchBody: Parameters<typeof patchDiscordAccountSettings>[1] = {
        status: currentSession.userStatus || 'online',
      }
      if (body.customStatus !== undefined || body.customStatusEmoji !== undefined) {
        const text = currentSession.customStatus
        const emoji = currentSession.customStatusEmoji
        patchBody.custom_status = text || emoji ? { text: text || '', emoji_name: emoji || null } : null
      }
      const patched = await patchDiscordAccountSettings(session.discordAccessToken, patchBody)
      accountSync = { ok: patched.ok, error: patched.error }
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
      accountSync,
      sync,
      message: !isStatusEnabled
        ? 'Status configuration saved (Status is OFF)'
        : accountSync && !accountSync.ok
          ? 'Status saved — Discord account sync will retry within 30s'
          : sync?.ok
            ? (sync.applied === false
                ? 'Saved — applying to Discord now (auto-retries until confirmed)'
                : autoNone
                  ? 'Idle/DND hides the VR/Mobile badge — icon saved as None & synced'
                  : autoOnline
                    ? 'Mobile/VR badge needs Online — status switched to Online & synced'
                    : 'Status updated & synced to Discord')
            : (autoNone
                ? 'Idle/DND hides the VR/Mobile badge — icon saved as None'
                : autoOnline
                  ? 'Mobile/VR badge needs Online — status switched to Online'
                  : 'Status saved — Discord sync will retry automatically'),
    })
  } catch (e: any) {
    console.error('Error in /api/status/update:', e)
    return NextResponse.json(
      { ok: false, error: 'status_update_failed', message: e?.message || 'Failed to update status' },
      { status: 500 }
    )
  }
}
