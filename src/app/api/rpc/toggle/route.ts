// 10X RPC — /api/rpc/toggle — Enable/Disable the PRIMARY RPC (slot 1)
// Legacy endpoint (the dashboard now uses per-slot toggles at
// /api/rpc/slots/[id]/toggle). Kept working for old clients: it operates on
// the user's FIRST slot only and — under Multi-RPC — never touches other
// slots' configs, the Game RPC or the Application RPC. Task 108: enabling
// the primary slot is MUTUALLY EXCLUSIVE — the other RPC1/2/3 slots are
// atomically disabled in the same transaction (one Normal RPC at a time).
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { syncPresence, syncPresenceVerified, stopPresence } from '@/lib/presence-sync'
import { requireSubscriptionAccess } from '@/lib/subscription'
import { enableSlotExclusively, normalizeRpcSlots } from '@/lib/rpc-slots'
import { ensureConfiguredBackfill, ensureRpcConfiguredColumn } from '@/lib/rpc-configured'

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
    // Task 108 — slot numbers auto-disabled by the mutual-exclusivity rule.
    let disabledSlots: number[] = []

    // The primary slot = the user's first RpcConfig row (slot 1 after
    // normalization).
    // Task 111 — column guard + legacy backfill, and the on-demand creation
    // below is REMOVED: enabling with NOTHING configured can no longer spawn
    // a default "10X RPC" presence (the exact ghost the screenshots showed).
    await ensureRpcConfiguredColumn()
    await ensureConfiguredBackfill(session.userId)
    const rows = await normalizeRpcSlots(session.userId)
    let primary = rows[0] ?? null

    if (enabled) {
      // 0. DISCORD LINK CHECK — an RPC toggle without a live Discord OAuth
      //    token would flip the DB to "enabled" while NOTHING runs on Discord.
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

      // 2. PRIMARY slot ON — MUTUALLY EXCLUSIVE (Task 108): every other
      //    RPC1/2/3 slot is atomically disabled in the same serialized
      //    transaction. Game RPC stays untouched.
      if (primary) {
        const result = await enableSlotExclusively(session.userId, primary.id)
        if (!result.ok) {
          return NextResponse.json({
            ok: false,
            error: 'toggle_failed',
            message: 'Could not enable the RPC — please try again',
          }, { status: 500 })
        }
        primary = result.row
        disabledSlots = result.disabledSlots
      } else {
        // Task 111 — there is NOTHING to enable: never fabricate a default
        // RPC here. The user must create & save an RPC first (Add RPC →
        // configure → Save), which is the only path that marks a slot
        // configured and therefore visible/enabled.
        return NextResponse.json({
          ok: false,
          error: 'no_rpc_configured',
          message: 'No RPC configured yet — add an RPC, save your settings, then enable it.',
        }, { status: 409 })
      }

      // 3. Master RPC gate ON.
      await db.session.updateMany({
        where: { userId: session.userId },
        data: {
          rpcEnabled: true,
          lastPresenceUpdate: new Date(),
        },
      })

      // 4. Push the full candidate set via the managed Gateway daemon —
      //    verified: the daemon confirms the RUNNING state matches the DB.
      let applied: boolean | undefined
      if (session.discordAccessToken) {
        const sync = await syncPresenceVerified(session.userId)
        applied = sync.applied
      }

      const offNames = disabledSlots.filter(s => s > 0).map(s => `RPC ${s}`)
      const offText = offNames.length
        ? ` — ${offNames.join(offNames.length > 1 ? ' and ' : ' & ')} turned off (one RPC at a time)`
        : ''

      return NextResponse.json({
        ok: true,
        enabled: true,
        rpcConfig: primary,
        disabledSlots,
        applied,
        message: `RPC enabled & live on Discord${offText}`,
      })
    } else {
      // 1. PRIMARY slot OFF — only its own flag flips.
      if (primary) {
        await db.rpcConfig.update({
          where: { id: primary.id },
          data: { enabled: false },
        })
      }

      // 2. Other enabled candidates (slots / Game RPC) keep the presence up.
      const slotsLeft = await db.rpcConfig.count({ where: { userId: session.userId, enabled: true } })
      const gamesLeft = await db.gameConfig.count({ where: { userId: session.userId, enabled: true } })
      const moreLeft = slotsLeft + gamesLeft > 0

      const statusSession = await db.session.findFirst({
        where: { userId: session.userId, statusEnabled: true },
      })
      const keepGateway = !!statusSession

      await db.session.updateMany({
        where: { userId: session.userId },
        data: {
          rpcEnabled: moreLeft,
          gatewayReady: moreLeft || keepGateway,
          lastPresenceUpdate: new Date(),
        },
      })

      if (session.discordAccessToken) {
        if (moreLeft) {
          await syncPresence(session.userId)
        } else {
          await stopPresence(session.userId)
        }
      }

      return NextResponse.json({
        ok: true,
        enabled: false,
        message: moreLeft
          ? 'RPC 1 stopped — remaining RPCs keep running'
          : 'RPC stopped & Rich Presence cleared from Discord',
      })
    }
  } catch (e: unknown) {
    console.error('Error in /api/rpc/toggle:', e)
    return NextResponse.json({
      ok: false,
      error: 'toggle_failed',
      message: e instanceof Error ? e.message : 'Failed to toggle RPC',
    }, { status: 500 })
  }
}
