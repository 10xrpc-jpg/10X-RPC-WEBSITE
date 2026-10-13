// 10X RPC — GET /api/admin/users/[id] — single-user deep view (admin only).
// Returns the full subscription picture: profile, subscription (raw + view),
// complete payment history, the user's admin-audit trail (who changed what,
// when, why) and the per-plan catalog for the change-plan dropdown.
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { avatarUrl } from '@/lib/discord-oauth'
import { CONFIG } from '@/lib/config'
import { sweepSubscription, subscriptionView } from '@/lib/subscription'
import { requireAdmin } from '@/lib/admin-guard'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { error } = await requireAdmin()
  if (error) return error

  const { id } = await params
  const user = await db.user.findUnique({
    where: { id },
    include: {
      subscription: true,
      payments: { orderBy: { createdAt: 'desc' }, take: 50 },
      sessions: { where: { expiresAt: { gt: new Date() } }, take: 1 },
    },
  })
  if (!user) return NextResponse.json({ error: 'not_found', message: 'User not found.' }, { status: 404 })

  // Per-user sweep so the state shown is current.
  const { sub } = await sweepSubscription(user.id, user.discordId).catch(() => ({ sub: user.subscription }))

  const audits = await db.auditLog.findMany({
    where: { OR: [{ targetId: user.id, targetType: 'user' }, { targetId: user.discordId }] },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })

  const plans = await db.plan.findMany({
    where: { archived: false },
    orderBy: [{ displayOrder: 'asc' }, { amount: 'desc' }],
  })

  const s = user.sessions[0]
  const now = new Date()
  return NextResponse.json({
    ok: true,
    user: {
      id: user.id,
      discordId: user.discordId,
      username: user.username,
      discriminator: user.discriminator,
      avatar: avatarUrl({ id: user.discordId, avatar: user.avatar, discriminator: user.discriminator || '0' }),
      createdAt: user.createdAt.toISOString(),
      adminNote: user.adminNote,
      isAdmin: CONFIG.admin.discordIds.includes(user.discordId),
      session: s ? {
        rpcEnabled: s.rpcEnabled,
        statusEnabled: s.statusEnabled,
        hasDiscordToken: !!s.discordAccessToken,
        vrStatusActive: s.vrStatusActive,
        userStatus: s.userStatus,
        lastPresenceUpdate: s.lastPresenceUpdate?.toISOString() ?? null,
      } : null,
    },
    subscription: sub ? {
      ...subscriptionView(sub, user.discordId, now),
      raw: {
        id: sub.id,
        plan: sub.plan,
        status: sub.status,
        createdAt: sub.createdAt.toISOString(),
        updatedAt: sub.updatedAt.toISOString(),
        trialEndsAt: sub.trialEndsAt?.toISOString() ?? null,
        currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
        suspendedAt: sub.suspendedAt?.toISOString() ?? null,
        trialUsed: sub.trialUsed,
      },
    } : null,
    payments: user.payments.map(p => ({
      id: p.id,
      orderId: p.orderId,
      paymentId: p.paymentId,
      plan: p.plan,
      planLabel: p.planLabel,
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      periodDays: p.periodDays,
      createdAt: p.createdAt.toISOString(),
    })),
    audits: audits.map(a => ({
      id: a.id,
      action: a.action,
      actorId: a.actorId,
      actorName: a.actorName,
      reason: a.reason,
      outcome: a.outcome,
      beforeJson: a.beforeJson,
      afterJson: a.afterJson,
      createdAt: a.createdAt.toISOString(),
    })),
    plans: plans.map(p => ({ slug: p.slug, name: p.name, amount: p.amount, durationDays: p.durationDays, active: p.active })),
    checkedAt: now.toISOString(),
  })
}
