// 10X RPC — /api/admin/stats — system overview for the admin dashboard.
// Returns (1) platform-wide counters from the DB and (2) live system health
// (database / Discord API / 24-7 daemon probes — reuses the cached uptime
// report so admin refreshes don't hammer the probes).
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { CONFIG } from '@/lib/config'
import { getUptimeReport } from '@/lib/uptime'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function GET() {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })
  }
  if (!CONFIG.admin.discordIds.includes(session.user.discordId)) {
    return NextResponse.json({ error: 'forbidden', message: 'Admin access required' }, { status: 403 })
  }

  const now = new Date()
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const activeWhere = { expiresAt: { gt: now } }

  const [
    totalUsers,
    newUsers24h,
    activeSessions,
    sessionsWithToken,
    rpcLive,
    statusEnabled,
    vrActive,
    sleepTimersActive,
    gamesEnabled,
    customGames,
    rotatorPresets,
    rotatorEnabledUsers,
    favorites,
    mirrorAssets,
    discordAssets,
    trialsActive,
    trialsExpired,
    oauthStates,
    recentUsers,
  ] = await Promise.all([
    db.user.count(),
    db.user.count({ where: { createdAt: { gte: dayAgo } } }),
    db.session.count({ where: activeWhere }),
    db.session.count({ where: { ...activeWhere, discordAccessToken: { not: null } } }),
    db.session.count({ where: { ...activeWhere, rpcEnabled: true } }),
    db.session.count({ where: { ...activeWhere, statusEnabled: true } }),
    db.session.count({ where: { ...activeWhere, vrStatusActive: true } }),
    db.session.count({ where: { ...activeWhere, sleepTimerActive: true, sleepTimerEndsAt: { gt: now } } }),
    db.gameConfig.count({ where: { enabled: true } }),
    db.gameConfig.count({ where: { appId: { not: null } } }),
    db.rotatorPreset.count(),
    db.globalConfig.count({ where: { rotatorEnabled: true } }),
    db.favoriteGame.count(),
    db.mirrorAsset.count(),
    db.discordAsset.count(),
    db.trial.count({ where: { active: true, endsAt: { gt: now } } }),
    db.trial.count({ where: { active: true, endsAt: { lte: now } } }),
    db.oAuthState.count({ where: { expiresAt: { gt: now } } }),
    // Newest users first (limit 5) — doubles as the source for the 7-day
    // signup trend (older signups are excluded by the where clause).
    db.user.findMany({
      where: { createdAt: { gte: weekAgo } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, username: true, createdAt: true },
    }),
  ])

  // 7-day signup trend (oldest → today) computed from the recentUsers rows.
  const signupTrend: { date: string; count: number }[] = []
  for (let i = 6; i >= 0; i--) {
    const day = new Date(now.getTime() - i * 24 * 60 * 60 * 1000)
    const key = day.toISOString().slice(0, 10)
    signupTrend.push({
      date: key,
      count: recentUsers.filter(u => u.createdAt.toISOString().slice(0, 10) === key).length,
    })
  }
  const newestUsers = recentUsers.slice(0, 5).map(u => ({
    id: u.id,
    username: u.username,
    createdAt: u.createdAt,
  }))

  // System health — best-effort: the stats page must never fail because a
  // probe timed out.
  let system
  try {
    const report = await getUptimeReport(false)
    system = {
      operational: report.operational,
      degraded: report.degraded,
      serverRegion: report.serverRegion,
      database: { ok: report.database.ok, latencyMs: report.database.latencyMs },
      discord: { ok: report.discord.ok, latencyMs: report.discord.latencyMs },
      daemon: {
        ok: report.daemon.ok,
        latencyMs: report.daemon.latencyMs,
        configured: report.daemon.configured,
        running: report.daemon.running,
        daemonUptimeSeconds: report.daemon.daemonUptimeSeconds,
        activeConnections: report.daemon.activeConnections,
        totalTrackedUsers: report.daemon.totalTrackedUsers,
      },
    }
  } catch (e) {
    console.error('[admin/stats] uptime report failed:', e)
    system = {
      operational: false,
      degraded: true,
      serverRegion: 'unknown',
      database: { ok: false, latencyMs: null },
      discord: { ok: false, latencyMs: null },
      daemon: { ok: false, latencyMs: null, configured: false },
    }
  }

  return NextResponse.json({
    ok: true,
    counts: {
      totalUsers,
      newUsers24h,
      activeSessions,
      sessionsWithToken,
      rpcLive,
      statusEnabled,
      vrActive,
      sleepTimersActive,
      gamesEnabled,
      customGames,
      rotatorPresets,
      rotatorEnabledUsers,
      favorites,
      mirrorAssets,
      discordAssets,
      trialsActive,
      trialsExpired,
      oauthStates,
    },
    system,
    signupTrend,
    newestUsers,
    checkedAt: now.toISOString(),
  })
}
