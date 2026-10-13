// 10X RPC — /api/admin/payments — Razorpay payment ledger for the admin
// Payments tab. Returns (1) a revenue summary (total / 30-day revenue, paid
// counts, paying users, plan breakdown) and (2) the latest 100 ledger rows
// joined with the payer's user info. Admin-only (server-side re-check).
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { CONFIG } from '@/lib/config'

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
  const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

  const [rows, aggTotal, agg30d, payingUsers, plusPaid, proPaid, createdCount] = await Promise.all([
    db.payment.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { user: { select: { username: true, discordId: true, avatar: true } } },
    }),
    db.payment.aggregate({ where: { status: 'paid' }, _sum: { amount: true }, _count: true }),
    db.payment.aggregate({ where: { status: 'paid', createdAt: { gte: d30 } }, _sum: { amount: true }, _count: true }),
    db.payment.groupBy({ by: ['userId'], where: { status: 'paid' }, _count: true }).then(g => g.length),
    db.payment.count({ where: { status: 'paid', plan: 'plus' } }),
    db.payment.count({ where: { status: 'paid', plan: 'pro' } }),
    db.payment.count({ where: { status: 'created' } }),
  ])

  return NextResponse.json({
    ok: true,
    summary: {
      revenueTotalPaise: aggTotal._sum.amount || 0,
      revenue30dPaise: agg30d._sum.amount || 0,
      paidCount: aggTotal._count,
      paid30dCount: agg30d._count,
      createdCount,
      payingUsers,
      plusPaid,
      proPaid,
    },
    payments: rows.map(p => ({
      id: p.id,
      orderId: p.orderId,
      paymentId: p.paymentId,
      plan: p.plan,
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      createdAt: p.createdAt.toISOString(),
      username: p.user.username,
      discordId: p.user.discordId,
      avatar: p.user.avatar,
    })),
    checkedAt: now.toISOString(),
  })
}
