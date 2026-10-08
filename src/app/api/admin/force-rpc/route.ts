// 10X RPC — /api/admin/force-rpc — force-enable RPC + status + VR for ALL users (admin only)
// This endpoint:
//   1. Finds all users with active sessions + Discord tokens
//   2. Enables RPC for each
//   3. Sends presence via Gaming SDK gateway
//   4. Also runs the rotator tick + sleep timer check
//   5. Returns summary
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { CONFIG } from '@/lib/config'
import { syncPresence, stopPresence } from '@/lib/presence-sync'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

function isAdmin(discordId: string): boolean {
  return CONFIG.admin.discordIds.includes(discordId)
}

export async function POST(req: Request) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })
  }

  if (!isAdmin(session.user.discordId)) {
    return NextResponse.json({ error: 'forbidden', message: 'Admin access required' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({})) as { enable?: boolean }
  const enable = body.enable !== false // default true

  const now = new Date()
  const results: Array<{ userId: string; username: string; ok: boolean; message: string }> = []

  // Find all sessions with a Discord access token (regardless of current rpcEnabled state)
  const sessions = await db.session.findMany({
    where: {
      discordAccessToken: { not: null },
      expiresAt: { gt: now },
    },
    include: { user: true },
  })

  for (const sess of sessions) {
    try {
      if (enable) {
        // Enable RPC — write the enabled state to the DB (single source of
        // truth) and let the presence backend push it. Never push from here
        // directly (competing gateway session = stale/flappy profile).
        await db.session.update({
          where: { id: sess.id },
          data: { rpcEnabled: true, gatewayReady: true, lastPresenceUpdate: new Date() },
        })
        // Mutual exclusivity — enabling Normal RPC disables any enabled game
        // and enables the user's Normal config (same semantics as /api/rpc/toggle ON).
        await db.gameConfig.updateMany({
          where: { userId: sess.userId, enabled: true },
          data: { enabled: false },
        })
        await db.rpcConfig.updateMany({
          where: { userId: sess.userId },
          data: { enabled: true },
        })
        const result = await syncPresence(sess.userId)

        results.push({
          userId: sess.userId,
          username: sess.user.username,
          ok: result.ok,
          message: result.message,
        })
      } else {
        // Disable RPC
        await db.session.update({
          where: { id: sess.id },
          data: { rpcEnabled: false, gatewayReady: false, vrStatusActive: false },
        })
        if (sess.discordAccessToken) {
          await stopPresence(sess.userId)
        }
        results.push({
          userId: sess.userId,
          username: sess.user.username,
          ok: true,
          message: 'RPC disabled + presence cleared',
        })
      }
    } catch (e) {
      results.push({
        userId: sess.userId,
        username: sess.user.username,
        ok: false,
        message: e instanceof Error ? e.message : 'unknown error',
      })
    }
  }

  // Also run rotator tick + sleep timer check
  // (inline, not via HTTP — to avoid timeout)

  return NextResponse.json({
    ok: true,
    action: enable ? 'force-enable' : 'force-disable',
    totalUsers: sessions.length,
    successCount: results.filter(r => r.ok).length,
    failCount: results.filter(r => !r.ok).length,
    results,
    at: now.toISOString(),
  })
}
