// 10X RPC — /api/rpc/keep-alive — 24/7 presence refresh for ALL active users
// Called by cron / self-ping every 5 minutes.
// For each user with rpcEnabled=true:
//   1. Refresh Discord token if expired
//   2. Re-send presence via Gaming SDK gateway
//   3. Re-apply custom status + user status via REST
//   4. Refresh VR status if active
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { applyPresence } from '@/lib/rpc-manager'
import { resolvePlaceholders } from '@/lib/placeholders'

export const dynamic = 'force-dynamic'
export const maxDuration = 60 // Allow up to 60s for multiple gateway connections

export async function POST(req: Request) {
  const secret = process.env.KEEP_ALIVE_SECRET
  if (secret) {
    const auth = req.headers.get('authorization') || ''
    const provided = auth.replace(/^Bearer\s+/i, '')
    if (provided !== secret) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
  }

  const now = new Date()
  const results: Array<{ userId: string; username: string; ok: boolean; message: string }> = []

  // Find all sessions with RPC enabled AND a Discord access token
  const activeSessions = await db.session.findMany({
    where: {
      rpcEnabled: true,
      discordAccessToken: { not: null },
      expiresAt: { gt: now },
    },
    include: {
      user: true,
    },
  })

  for (const session of activeSessions) {
    try {
      // Check sleep timer — skip if sleep timer has expired
      if (session.sleepTimerActive && session.sleepTimerEndsAt && session.sleepTimerEndsAt < now) {
        await db.session.update({
          where: { id: session.id },
          data: {
            sleepTimerActive: false,
            sleepTimerEndsAt: null,
            rpcEnabled: false,
            gatewayReady: false,
            vrStatusActive: false,
          },
        })
        results.push({
          userId: session.userId,
          username: session.user.username,
          ok: true,
          message: 'Sleep timer expired — RPC disabled',
        })
        continue
      }

      // Load RPC config + global config for this user
      const rpcConfig = await db.rpcConfig.findFirst({ where: { userId: session.userId } })
      const globalConfig = await db.globalConfig.findUnique({ where: { userId: session.userId } })

      const placeholderCtx = {
        timezone: globalConfig?.timezone || 'UTC',
        city: globalConfig?.city || undefined,
        rpcStartedAt: session.createdAt.getTime(),
      }

      // Re-apply presence
      const result = await applyPresence(
        {
          id: session.id,
          userId: session.userId,
          discordAccessToken: session.discordAccessToken,
          discordRefreshToken: session.discordRefreshToken,
          discordTokenExpiresAt: session.discordTokenExpiresAt,
          userStatus: session.userStatus,
          customStatus: session.customStatus,
          customStatusEmoji: session.customStatusEmoji,
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
          enabled: rpcConfig.enabled,
        } : null,
        placeholderCtx
      )

      results.push({
        userId: session.userId,
        username: session.user.username,
        ok: result.ok,
        message: result.message,
      })
    } catch (e) {
      results.push({
        userId: session.userId,
        username: session.user.username,
        ok: false,
        message: e instanceof Error ? e.message : 'unknown error',
      })
    }
  }

  return NextResponse.json({
    ok: true,
    totalActive: activeSessions.length,
    successCount: results.filter(r => r.ok).length,
    failCount: results.filter(r => !r.ok).length,
    results,
    at: now.toISOString(),
  })
}
