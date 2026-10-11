// 10X RPC — GET /api/admin/subscriptions — subscription management list.
// Server-side search / filters / sort / pagination for the admin Users tab:
//   q        — search username, Discord ID or user id
//   status   — all | trialing | active | suspended | expired | expiring
//              (expired = suspended past its end; expiring = ends within 7d)
//   plan     — plan slug (free | plus | pro | lifetime | <custom>)
//   sort     — createdAt | expiry | username | daysLeft   (prefix - for desc)
//   page     — 1-based page number
//   pageSize — rows per page (max 100, default 25)
// Every row carries the full subscription view + last payment, and the sweep
// runs first so suspended states are always current.
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { avatarUrl } from '@/lib/discord-oauth'
import { CONFIG } from '@/lib/config'
import { sweepAllSubscriptions, subscriptionView } from '@/lib/subscription'
import { requireAdmin } from '@/lib/admin-guard'

export const dynamic = 'force-dynamic'

const PAGE_MAX = 100

export async function GET(req: Request) {
  const { error } = await requireAdmin()
  if (error) return error

  const url = new URL(req.url)
  const q = (url.searchParams.get('q') || '').trim()
  const status = url.searchParams.get('status') || 'all'
  const plan = url.searchParams.get('plan') || 'all'
  const sortRaw = url.searchParams.get('sort') || '-createdAt'
  const desc = sortRaw.startsWith('-')
  const sort = sortRaw.replace(/^-/, '')
  const page = Math.max(1, Math.round(Number(url.searchParams.get('page')) || 1))
  const pageSize = Math.min(PAGE_MAX, Math.max(5, Math.round(Number(url.searchParams.get('pageSize')) || 25)))

  await sweepAllSubscriptions().catch(() => {})

  const now = new Date()
  const in7d = new Date(now.getTime() + 7 * 24 * 3600 * 1000)

  // Subscription-level filter (used inside the user relation filter).
  let subWhere: Record<string, unknown> | undefined
  if (status === 'trialing') subWhere = { status: 'trialing' }
  else if (status === 'active') subWhere = { status: 'active' }
  else if (status === 'suspended') {
    // Admin-suspended = suspended but NOT yet past its recorded end.
    subWhere = {
      status: 'suspended',
      OR: [
        { currentPeriodEnd: { gt: now } },
        { AND: [{ currentPeriodEnd: null }, { OR: [{ trialEndsAt: { gt: now } }, { trialEndsAt: null }] }] },
      ],
    }
  } else if (status === 'expired') {
    subWhere = {
      status: 'suspended',
      OR: [
        { currentPeriodEnd: { lt: now } },
        { AND: [{ currentPeriodEnd: null }, { trialEndsAt: { lt: now } }] },
      ],
    }
  } else if (status === 'expiring') {
    subWhere = {
      OR: [
        { status: 'active', currentPeriodEnd: { gte: now, lte: in7d } },
        { status: 'trialing', trialEndsAt: { gte: now, lte: in7d } },
      ],
    }
  }
  if (plan !== 'all' && subWhere) {
    subWhere = { AND: [subWhere, { plan }] }
  } else if (plan !== 'all') {
    subWhere = { plan }
  }

  const userWhere: Record<string, unknown> = {}
  if (q) {
    userWhere.OR = [
      { username: { contains: q, mode: 'insensitive' } },
      { discordId: { contains: q } },
      { id: q },
    ]
  }
  if (subWhere) userWhere.subscription = { is: subWhere }

  try {
    const [totalUsers, filtered, trialing, active, suspendedAll, expiringSoon, lifetime] = await Promise.all([
      db.user.count(),
      db.user.count({ where: userWhere }),
      db.subscription.count({ where: { status: 'trialing' } }),
      db.subscription.count({ where: { status: 'active' } }),
      db.subscription.count({ where: { status: 'suspended' } }),
      db.subscription.count({
        where: {
          OR: [
            { status: 'active', currentPeriodEnd: { gte: now, lte: in7d } },
            { status: 'trialing', trialEndsAt: { gte: now, lte: in7d } },
          ],
        },
      }),
      db.subscription.count({ where: { plan: 'lifetime', status: 'active' } }),
    ])

    const users = await db.user.findMany({
      where: userWhere,
      include: {
        subscription: true,
        sessions: { where: { expiresAt: { gt: now } }, take: 1, orderBy: { expiresAt: 'desc' } },
        payments: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: sort === 'username'
        ? { username: desc ? 'desc' : 'asc' }
        : { createdAt: desc ? 'desc' : 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    })

    // expiry / daysLeft sorting happens in JS (they're derived values).
    const rows = users.map(u => {
      const sub = u.subscription
        ? subscriptionView(u.subscription, u.discordId, now)
        : { plan: 'free', status: 'suspended', allowed: false, daysLeft: 0, msLeft: 0, trialEndsAt: null, currentPeriodEnd: null, suspendedAt: null, endsAt: null, neverExpires: false, admin: false }
      const s = u.sessions[0]
      const lastPayment = u.payments[0]
      return {
        id: u.id,
        discordId: u.discordId,
        username: u.username,
        avatar: avatarUrl({ id: u.discordId, avatar: u.avatar, discriminator: u.discriminator || '0' }),
        createdAt: u.createdAt.toISOString(),
        adminNote: u.adminNote,
        subscription: sub,
        subscriptionRaw: sub ? {
          createdAt: u.subscription!.createdAt.toISOString(),
          updatedAt: u.subscription!.updatedAt.toISOString(),
        } : null,
        session: s ? { rpcEnabled: s.rpcEnabled, hasDiscordToken: !!s.discordAccessToken, userStatus: s.userStatus } : null,
        lastPayment: lastPayment ? {
          plan: lastPayment.plan,
          planLabel: lastPayment.planLabel,
          amount: lastPayment.amount,
          status: lastPayment.status,
          createdAt: lastPayment.createdAt.toISOString(),
        } : null,
        isAdmin: CONFIG.admin.discordIds.includes(u.discordId),
      }
    })

    if (sort === 'expiry' || sort === 'daysLeft') {
      rows.sort((a, b) => {
        const av = a.subscription.endsAt ? new Date(a.subscription.endsAt).getTime() : (a.subscription.neverExpires ? Number.POSITIVE_INFINITY : 0)
        const bv = b.subscription.endsAt ? new Date(b.subscription.endsAt).getTime() : (b.subscription.neverExpires ? Number.POSITIVE_INFINITY : 0)
        return desc ? bv - av : av - bv
      })
    }

    return NextResponse.json({
      ok: true,
      page,
      pageSize,
      filtered,
      totalPages: Math.max(1, Math.ceil(filtered / pageSize)),
      summary: {
        total: totalUsers,
        trialing,
        active,
        suspended: suspendedAll,
        expiringSoon,
        lifetime,
      },
      users: rows,
      checkedAt: now.toISOString(),
    })
  } catch (e) {
    console.error('[admin/subscriptions] list failed:', e)
    return NextResponse.json({ error: 'unavailable', message: 'Could not load subscriptions.' }, { status: 500 })
  }
}
