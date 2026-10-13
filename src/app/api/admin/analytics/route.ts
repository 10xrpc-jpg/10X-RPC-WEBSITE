// 10X RPC — GET /api/admin/analytics — subscription analytics (admin only).
// Every number is computed from the live database — no mocks, no hardcoded
// dashboard figures:
//   • subscription counts: trialing / active / suspended (+ expired derived)
//   • lifetime access holders + upcoming expirations (7d / 30d)
//   • trial → paid conversion (distinct paying users ÷ accounts that ever
//     held a trial) and plan popularity (subscriptions + payments)
//   • revenue from VERIFIED payments only (all-time + 30d), renewals
//   • 14-day trends: signups, paid activations, revenue per day
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/admin-guard'

export const dynamic = 'force-dynamic'

const DAY_MS = 24 * 60 * 60 * 1000

export async function GET() {
  const { error } = await requireAdmin()
  if (error) return error

  try {
    const now = new Date()
    const in7d = new Date(now.getTime() + 7 * DAY_MS)
    const in30d = new Date(now.getTime() + 30 * DAY_MS)
    const since30 = new Date(now.getTime() - 30 * DAY_MS)
    const since14 = new Date(now.getTime() - 14 * DAY_MS)

    const [
      totalSubs,
      subsTrialing,
      subsActive,
      subsSuspended,
      subsLifetime,
      expiring7,
      expiring30,
      everTrialed,
      paidGroupByUser,
      payPlanGroups,
      subPlanGroups,
      revenueAll,
      revenue30,
      paidPayments,
    ] = await Promise.all([
      db.subscription.count(),
      db.subscription.count({ where: { status: 'trialing' } }),
      db.subscription.count({ where: { status: 'active' } }),
      db.subscription.count({ where: { status: 'suspended' } }),
      db.subscription.count({ where: { plan: 'lifetime', status: 'active' } }),
      // Upcoming expirations: active paid periods ending in window.
      db.subscription.count({
        where: { status: 'active', currentPeriodEnd: { gt: now, lte: in7d } },
      }),
      db.subscription.count({
        where: { status: 'active', currentPeriodEnd: { gt: now, lte: in30d } },
      }),
      // Accounts that ever held a trial (the trial phase is how every free
      // account starts) — trialEndsAt set OR the trial was explicitly used.
      db.subscription.count({ where: { OR: [{ trialEndsAt: { not: null } }, { trialUsed: true }] } }),
      // Distinct paying users (verified payments only) + per-user counts for
      // renewal math.
      db.payment.groupBy({ by: ['userId'], where: { status: 'paid' }, _count: { _all: true } }),
      db.payment.groupBy({
        by: ['plan'],
        where: { status: 'paid' },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      db.subscription.groupBy({ by: ['plan'], _count: { _all: true } }),
      db.payment.aggregate({ where: { status: 'paid' }, _sum: { amount: true }, _count: { _all: true } }),
      db.payment.aggregate({ where: { status: 'paid', createdAt: { gte: since30 } }, _sum: { amount: true }, _count: { _all: true } }),
      db.payment.findMany({
        where: { status: 'paid', createdAt: { gte: since14 } },
        select: { amount: true, createdAt: true },
      }),
    ])

    // Expired = suspended accounts whose recorded end has passed (time ran
    // out); admin-suspended = suspended with time still remaining.
    const nowMs = now.getTime()
    const suspendedRows = await db.subscription.findMany({
      where: { status: 'suspended' },
      select: { trialEndsAt: true, currentPeriodEnd: true },
    })
    let subsExpired = 0
    let subsAdminSuspended = 0
    for (const s of suspendedRows) {
      const end = s.currentPeriodEnd?.getTime() ?? s.trialEndsAt?.getTime() ?? null
      if (end != null && end < nowMs) subsExpired++
      else subsAdminSuspended++
    }

    // Conversion: distinct paying users ÷ accounts that ever trialed.
    const payingUsers = paidGroupByUser.length
    const conversionRate = everTrialed > 0 ? Math.round((payingUsers / everTrialed) * 1000) / 10 : 0
    // Renewals = paid payments beyond each user's first.
    const renewals = paidGroupByUser.reduce((acc, g) => acc + Math.max(0, g._count._all - 1), 0)

    // 14-day trend buckets (signups + paid activations + revenue).
    const signups14 = await db.user.findMany({ where: { createdAt: { gte: since14 } }, select: { createdAt: true } })
    const trend: { date: string; signups: number; paid: number; revenuePaise: number }[] = []
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now.getTime() - i * DAY_MS)
      trend.push({ date: d.toISOString().slice(0, 10), signups: 0, paid: 0, revenuePaise: 0 })
    }
    const bucketIndex = (iso: Date) => {
      const days = Math.floor((now.getTime() - iso.getTime()) / DAY_MS)
      return 13 - Math.min(13, Math.max(0, days))
    }
    for (const u of signups14) trend[bucketIndex(u.createdAt)].signups++
    for (const p of paidPayments) {
      const idx = bucketIndex(p.createdAt)
      trend[idx].paid++
      trend[idx].revenuePaise += p.amount
    }

    return NextResponse.json({
      ok: true,
      subscriptions: {
        total: totalSubs,
        trialing: subsTrialing,
        active: subsActive,
        suspended: subsSuspended,
        expired: subsExpired,
        adminSuspended: subsAdminSuspended,
        lifetime: subsLifetime,
        expiring7d: expiring7,
        expiring30d: expiring30,
      },
      conversion: {
        everTrialed,
        payingUsers,
        rate: conversionRate,
        renewals,
      },
      revenue: {
        allTimePaise: revenueAll._sum.amount ?? 0,
        last30dPaise: revenue30._sum.amount ?? 0,
        paidCount: revenueAll._count._all,
        paid30dCount: revenue30._count._all,
        payingUsers,
      },
      planPopularity: {
        subscriptions: subPlanGroups
          .map(g => ({ plan: g.plan, count: g._count._all }))
          .sort((a, b) => b.count - a.count),
        payments: payPlanGroups
          .map(g => ({ plan: g.plan, count: g._count._all, revenuePaise: g._sum.amount ?? 0 }))
          .sort((a, b) => b.revenuePaise - a.revenuePaise),
      },
      trend,
      checkedAt: now.toISOString(),
    })
  } catch (e) {
    console.error('[admin/analytics] failed:', e)
    return NextResponse.json({ error: 'unavailable', message: 'Could not compute analytics.' }, { status: 500 })
  }
}
