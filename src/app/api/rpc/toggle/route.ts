// 10X RPC — /api/rpc/toggle — Enable/Disable the PRIMARY RPC (slot 1)
// Legacy endpoint (the dashboard now uses per-slot toggles at
// /api/rpc/slots/[id]/toggle). Kept working for old clients: it operates on
// the user's FIRST slot only and — under Multi-RPC — never touches other
// slots or the isolated Game RPC.
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { syncPresence, stopPresence } from '@/lib/presence-sync'
import { requireSubscriptionAccess } from '@/lib/subscription'
import { normalizeRpcSlots } from '@/lib/rpc-slots'

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

    // The primary slot = the user's first RpcConfig row (slot 1 after
    // normalization; created on demand exactly like the legacy behavior).
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

      // 2. PRIMARY slot ON — other slots and the Game RPC stay untouched.
      if (primary) {
        primary = await db.rpcConfig.update({
          where: { id: primary.id },
          data: { enabled: true },
        })
      } else {
        primary = await db.rpcConfig.create({
          data: {
            userId: session.userId,
            slot: 1,
            name: '10X RPC',
            type: 'PLAYING',
            platform: 'desktop',
            enabled: true,
            startMinsAgo: 0,
          },
        })
      }

      // 3. Master RPC gate ON.
      await db.session.updateMany({
        where: { userId: session.userId },
        data: {
          rpcEnabled: true,
          lastPresenceUpdate: new Date(),
        },
      })

      // 4. Push the full candidate set via the managed Gateway daemon.
      if (session.discordAccessToken) {
        await syncPresence(session.userId)
      }

      return NextResponse.json({
        ok: true,
        enabled: true,
        rpcConfig: primary,
        message: 'RPC enabled & live on Discord',
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
