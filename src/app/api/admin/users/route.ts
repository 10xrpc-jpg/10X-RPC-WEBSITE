// 10X RPC — /api/admin/users — list all users with their RPC state (admin only)
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { CONFIG } from '@/lib/config'
import { avatarUrl } from '@/lib/discord-oauth'

export const dynamic = 'force-dynamic'

function isAdmin(discordId: string): boolean {
  return CONFIG.admin.discordIds.includes(discordId)
}

export async function GET() {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })
  }

  if (!isAdmin(session.user.discordId)) {
    return NextResponse.json({ error: 'forbidden', message: 'Admin access required' }, { status: 403 })
  }

  const users = await db.user.findMany({
    include: {
      sessions: {
        where: { expiresAt: { gt: new Date() } },
        take: 1,
      },
      trial: true,
      rpcConfigs: { take: 1 },
      globalConfig: true,
    },
  })

  const userList = users.map(u => {
    const s = u.sessions[0]
    const trial = u.trial
    const rpc = u.rpcConfigs[0]
    const now = new Date()
    return {
      id: u.id,
      discordId: u.discordId,
      username: u.username,
      avatar: avatarUrl({ id: u.discordId, avatar: u.avatar, discriminator: u.discriminator || '0' }),
      createdAt: u.createdAt,
      trial: trial ? {
        active: trial.active && trial.endsAt > now,
        endsAt: trial.endsAt,
        daysLeft: Math.max(0, Math.ceil((trial.endsAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))),
      } : null,
      rpc: s ? {
        rpcEnabled: s.rpcEnabled,
        gatewayReady: s.gatewayReady,
        userStatus: s.userStatus,
        customStatus: s.customStatus,
        customStatusEmoji: s.customStatusEmoji,
        vrStatusActive: s.vrStatusActive,
        hasDiscordToken: !!s.discordAccessToken,
        lastPresenceUpdate: s.lastPresenceUpdate,
        sleepTimerActive: s.sleepTimerActive && s.sleepTimerEndsAt && s.sleepTimerEndsAt > now,
        sleepTimerEndsAt: s.sleepTimerEndsAt,
      } : null,
      rpcConfig: rpc ? {
        name: rpc.name,
        type: rpc.type,
        platform: rpc.platform,
        enabled: rpc.enabled,
      } : null,
      globalConfig: u.globalConfig ? {
        city: u.globalConfig.city,
        timezone: u.globalConfig.timezone,
        rotatorEnabled: u.globalConfig.rotatorEnabled,
      } : null,
      isAdmin: isAdmin(u.discordId),
    }
  })

  return NextResponse.json({
    ok: true,
    totalUsers: userList.length,
    activeRpcUsers: userList.filter(u => u.rpc?.rpcEnabled).length,
    users: userList,
  })
}
