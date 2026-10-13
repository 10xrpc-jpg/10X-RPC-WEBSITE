// 10X RPC — /api/admin/plans — plan catalog management (admin only).
//   GET   — every plan (incl. archived/invisible) + subscriber & revenue
//           stats per slug (live counts from Subscription/Payment rows).
//   POST  — create a plan. Amount is in PAISE; durationDays 1–3650.
// Deletion is handled by PATCH archive (rows are never hard-deleted while
// referenced; DELETE only works for plans with zero payments/subscriptions).
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { listAllPlans } from '@/lib/plans'
import { requireAdmin, adminRateLimited, writeAudit } from '@/lib/admin-guard'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { session, error } = await requireAdmin()
  if (error) return error

  try {
    const plans = await listAllPlans()
    // Per-slug stats: how many users sit on each plan + how much revenue it
    // has produced (paid payments only). Live database numbers, no mocks.
    const [subGroups, payGroups] = await Promise.all([
      db.subscription.groupBy({ by: ['plan'], _count: { _all: true } }),
      db.payment.groupBy({ by: ['plan'], where: { status: 'paid' }, _count: { _all: true }, _sum: { amount: true } }),
    ])
    const subMap = new Map(subGroups.map(g => [g.plan, g._count._all]))
    const payMap = new Map(payGroups.map(g => [g.plan, { count: g._count._all, revenuePaise: g._sum.amount ?? 0 }]))
    return NextResponse.json({
      ok: true,
      plans: plans.map(p => ({
        ...p,
        subscribers: subMap.get(p.slug) ?? 0,
        paidCount: payMap.get(p.slug)?.count ?? 0,
        revenuePaise: payMap.get(p.slug)?.revenuePaise ?? 0,
      })),
      checkedAt: new Date().toISOString(),
      admin: session.user.discordId,
    })
  } catch (e) {
    console.error('[admin/plans] list failed:', e)
    return NextResponse.json({ error: 'plans_unavailable', message: 'Could not load plans.' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const { session, error } = await requireAdmin()
  if (error) return error
  const limited = adminRateLimited(req, 'plans-write')
  if (limited) return limited

  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const slug = String(body.slug ?? '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '')
  const name = String(body.name ?? '').trim()
  const amount = Math.round(Number(body.amount))
  const durationDays = Math.round(Number(body.durationDays))
  if (!slug || !name || !Number.isFinite(amount) || amount < 0 || amount > 100_000_000) {
    return NextResponse.json({ error: 'bad_request', message: 'slug, name and a valid amount (paise) are required.' }, { status: 400 })
  }
  if (!Number.isFinite(durationDays) || durationDays < 1 || durationDays > 3650) {
    return NextResponse.json({ error: 'bad_request', message: 'durationDays must be 1–3650.' }, { status: 400 })
  }

  const features = Array.isArray(body.features) ? body.features.map(f => String(f).slice(0, 120)).filter(Boolean).slice(0, 12) : []
  const originalAmountRaw = Number(body.originalAmount)
  const originalAmount = Number.isFinite(originalAmountRaw) && originalAmountRaw > 0 ? Math.round(originalAmountRaw) : null

  try {
    const exists = await db.plan.findUnique({ where: { slug } })
    if (exists) {
      return NextResponse.json({ error: 'slug_taken', message: `Plan slug "${slug}" already exists.` }, { status: 409 })
    }
    const plan = await db.plan.create({
      data: {
        slug,
        name: name.slice(0, 60),
        description: typeof body.description === 'string' ? body.description.slice(0, 300) : null,
        amount,
        originalAmount,
        durationDays,
        badge: typeof body.badge === 'string' && body.badge.trim() ? body.badge.trim().slice(0, 24) : null,
        featuresJson: JSON.stringify(features),
        active: body.active !== false,
        visible: body.visible !== false,
        displayOrder: Number.isFinite(Number(body.displayOrder)) ? Math.round(Number(body.displayOrder)) : 10,
        archived: false,
      },
    })
    await writeAudit({
      action: 'plan.create',
      actorId: session.user.discordId,
      actorName: session.user.username,
      targetType: 'plan',
      targetId: plan.id,
      targetLabel: plan.name,
      after: plan,
      reason: typeof body.reason === 'string' ? body.reason : null,
    })
    return NextResponse.json({ ok: true, plan })
  } catch (e) {
    console.error('[admin/plans] create failed:', e)
    return NextResponse.json({ error: 'create_failed', message: 'Could not create the plan.' }, { status: 500 })
  }
}
