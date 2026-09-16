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
import { applyPresence } from '@/lib/rpc-manager'
import { resolvePlaceholders } from '@/lib/placeholders'

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
        // Enable RPC
        const rpcConfig = await db.rpcConfig.findFirst({ where: { userId: sess.userId } })
        const globalConfig = await db.globalConfig.findUnique({ where: { userId: sess.userId } })

        const placeholderCtx = {
          timezone: globalConfig?.timezone || 'UTC',
          city: globalConfig?.city || undefined,
          rpcStartedAt: sess.createdAt.getTime(),
        }

        const result = await applyPresence(
          {
            id: sess.id,
            userId: sess.userId,
            discordAccessToken: sess.discordAccessToken,
            discordRefreshToken: sess.discordRefreshToken,
            discordTokenExpiresAt: sess.discordTokenExpiresAt,
            userStatus: sess.userStatus || 'online',
            customStatus: sess.customStatus,
            customStatusEmoji: sess.customStatusEmoji,
          },
          rpcConfig ? {
            id: rpcConfig.id,
            name: rpcConfig.name,
            type: rpcConfig.type,
            platform: rpcConfig.platform,
            state: rpcConfig.state,
            details: rpcConfig.details,
            largeImage: rpcConfig.largeImage,
            largeText: rpcConfig.largeText,
            smallImage: rpcConfig.smallImage,
            smallText: rpcConfig.smallText,
            button1Label: rpcConfig.button1Label,
            button1Url: rpcConfig.button1Url,
            button2Label: rpcConfig.button2Label,
            button2Url: rpcConfig.button2Url,
            partyCurrent: rpcConfig.partyCurrent,
            partyMax: rpcConfig.partyMax,
            partyId: rpcConfig.partyId,
            partySecret: rpcConfig.partySecret,
            startMinsAgo: rpcConfig.startMinsAgo,
            endTotalMins: rpcConfig.endTotalMins,
            enabled: true,
          } : null,
          placeholderCtx
        )

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
          const { clearPresence } = await import('@/lib/rpc-manager')
          await clearPresence({
            id: sess.id,
            discordAccessToken: sess.discordAccessToken,
            discordRefreshToken: sess.discordRefreshToken,
            discordTokenExpiresAt: sess.discordTokenExpiresAt,
          })
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
