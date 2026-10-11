// 10X RPC — /api/admin/sessions — session monitor for the admin dashboard.
// Lists sessions (active by default, ?scope=expired for recently expired) with
// user info + live RPC flags so admins can see who is online and intervene.
// The admin's own CURRENT session is flagged `isCurrent` (revoke blocked
// server-side in /api/admin/session-action to prevent self-logout).
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { CONFIG } from '@/lib/config'
import { avatarUrl } from '@/lib/discord-oauth'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })
  }
  if (!CONFIG.admin.discordIds.includes(session.user.discordId)) {
    return NextResponse.json({ error: 'forbidden', message: 'Admin access required' }, { status: 403 })
  }

  const url = new URL(req.url)
  const scope = url.searchParams.get('scope') === 'expired' ? 'expired' : 'active'
  const now = new Date()
  const dayAhead = new Date(now.getTime() + 24 * 60 * 60 * 1000)

  const [rows, activeCount, expiredCount, expiringSoon, withTokenActive, rpcLiveActive] = await Promise.all([
    db.session.findMany({
      where: scope === 'active' ? { expiresAt: { gt: now } } : { expiresAt: { lte: now } },
      orderBy: scope === 'active' ? { expiresAt: 'asc' } : { expiresAt: 'desc' },
      take: scope === 'active' ? 200 : 50,
      include: { user: { select: { id: true, discordId: true, username: true, discriminator: true, avatar: true } } },
    }),
    db.session.count({ where: { expiresAt: { gt: now } } }),
    db.session.count({ where: { expiresAt: { lte: now } } }),
    db.session.count({ where: { expiresAt: { gt: now, lte: dayAhead } } }),
    db.session.count({ where: { expiresAt: { gt: now }, discordAccessToken: { not: null } } }),
    db.session.count({ where: { expiresAt: { gt: now }, rpcEnabled: true } }),
  ])

  const sessions = rows.map(s => ({
    id: s.id,
    userId: s.user.id,
    username: s.user.username,
    avatar: avatarUrl({ id: s.user.discordId, avatar: s.user.avatar, discriminator: s.user.discriminator || '0' }),
    discordId: s.user.discordId,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    statusEnabled: s.statusEnabled,
    rpcEnabled: s.rpcEnabled,
    gatewayReady: s.gatewayReady,
    userStatus: s.userStatus,
    customStatus: s.customStatus,
    customStatusEmoji: s.customStatusEmoji,
    statusPlatform: s.statusPlatform,
    vrStatusActive: s.vrStatusActive,
    hasDiscordToken: !!s.discordAccessToken,
    sleepTimerActive: s.sleepTimerActive && !!s.sleepTimerEndsAt && s.sleepTimerEndsAt > now,
    lastPresenceUpdate: s.lastPresenceUpdate,
    isCurrent: s.id === session.id,
    isSelf: s.user.discordId === session.user.discordId,
  }))

  return NextResponse.json({
    ok: true,
    scope,
    summary: {
      activeCount,
      expiredCount,
      expiringSoon24h: expiringSoon,
      withTokenActive,
      rpcLiveActive,
    },
    sessions,
  })
}
