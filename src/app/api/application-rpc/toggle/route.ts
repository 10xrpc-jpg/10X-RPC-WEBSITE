// 10X RPC — /api/application-rpc/toggle — enable/disable ONLY the Application
// RPC (Task 90). Each RPC system owns its enable flag exclusively:
//   • enable  → THIS row's flag ON + runState 'starting' (the daemon flips it
//     to 'running' only after a real gateway session is live)
//   • disable → THIS row's flag OFF + idle; the daemon closes ONLY the
//     Application RPC session
// The Session.rpcEnabled master gate, RpcConfig rows and GameConfig rows are
// never read or written here — Normal RPC and Game RPC are untouched.
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { requireSubscriptionAccess } from '@/lib/subscription'
import { isUsableApplicationRpcAppId, serializeApplicationRpc } from '@/lib/application-rpc'
import { ensureApplicationRpcRow } from '@/lib/application-rpc-server'
import { syncApplicationPresence } from '@/lib/application-presence-sync'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function POST(req: Request) {
  try {
    const session = await getSession()
    if (!session) {
      return NextResponse.json({ ok: false, error: 'not_authenticated' }, { status: 401 })
    }

    const body = await req.json() as { enabled?: boolean }
    const enabled = !!body.enabled

    const row = await ensureApplicationRpcRow(session.userId)

    if (enabled) {
      // 0. DISCORD LINK CHECK — a toggle without a live Discord OAuth token
      //    would flip the DB while NOTHING runs on Discord (honest states).
      if (!session.discordAccessToken) {
        return NextResponse.json(
          { ok: false, error: 'discord_not_linked', message: 'Connect your Discord account first — click Reconnect Discord.' },
          { status: 403 }
        )
      }

      // 1. Subscription gate — same rules, enforced independently.
      const denied = await requireSubscriptionAccess(session.userId, session.user.discordId)
      if (denied) {
        return NextResponse.json(
          { ok: false, error: denied.error, message: denied.message },
          { status: 403 }
        )
      }

      // 2. A configured Application ID is REQUIRED — Application RPC exists to
      //    present presence under a specific Discord application.
      if (!isUsableApplicationRpcAppId(row.appId)) {
        return NextResponse.json(
          {
            ok: false,
            error: 'app_id_required',
            message: 'Set a Discord Application ID first — Application RPC runs under its own application. Enter one on the card and save.',
          },
          { status: 400 }
        )
      }

      // 3. THIS system ON — runState 'starting' until the daemon reports a
      //    live session (never pre-announces success).
      const updated = await db.applicationRpcConfig.update({
        where: { userId: session.userId },
        data: { enabled: true, runState: 'starting', runError: null, runSinceAt: new Date().toISOString() },
      })

      // 4. Instant sync (daemon picks it up; its 10s tick is the backstop).
      if (session.discordAccessToken) {
        await syncApplicationPresence(session.userId)
      }

      return NextResponse.json({
        ok: true,
        enabled: true,
        config: serializeApplicationRpc(updated),
        message: 'Application RPC enabled — presence goes live within seconds',
      })
    } else {
      // THIS system OFF — only its own row flips. Other RPC systems keep
      // running untouched (no shared session teardown, no master-gate writes).
      const updated = await db.applicationRpcConfig.update({
        where: { userId: session.userId },
        data: { enabled: false, runState: 'idle', runError: null, runSinceAt: new Date().toISOString() },
      })

      if (session.discordAccessToken) {
        await syncApplicationPresence(session.userId)
      }

      return NextResponse.json({
        ok: true,
        enabled: false,
        config: serializeApplicationRpc(updated),
        message: 'Application RPC disabled & cleared from Discord',
      })
    }
  } catch (e: unknown) {
    console.error('Error in /api/application-rpc/toggle:', e)
    return NextResponse.json({
      ok: false,
      error: 'toggle_failed',
      message: e instanceof Error ? e.message : 'Failed to toggle Application RPC',
    }, { status: 500 })
  }
}
