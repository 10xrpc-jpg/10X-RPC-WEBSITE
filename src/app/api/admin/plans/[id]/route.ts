// 10X RPC — /api/admin/plans/[id] — edit, archive or delete a plan.
//   PATCH  — any field (name/price/duration/badge/features/active/visible/
//            order…). Live subscriber entitlements are NEVER touched: paid
//            periods were already granted; only future checkouts use the
//            new values. Payment rows keep their snapshots.
//   DELETE — allowed ONLY when no payment or subscription references the
//            plan's slug; otherwise the caller is told to archive instead
//            (history must stay intact).
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { planView } from '@/lib/plans'
import { requireAdmin, adminRateLimited, writeAudit } from '@/lib/admin-guard'

export const dynamic = 'force-dynamic'

const MAX_DURATION_DAYS = 3650

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireAdmin()
  if (error) return error
  const limited = adminRateLimited(req, 'plans-write')
  if (limited) return limited

  const { id } = await params
  const plan = await db.plan.findUnique({ where: { id } })
  if (!plan) return NextResponse.json({ error: 'not_found', message: 'Plan not found.' }, { status: 404 })

  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const data: Record<string, unknown> = {}

  if (body.name !== undefined) {
    const name = String(body.name).trim()
    if (!name) return NextResponse.json({ error: 'bad_request', message: 'name cannot be empty.' }, { status: 400 })
    data.name = name.slice(0, 60)
  }
  if (body.description !== undefined) {
    data.description = body.description === null ? null : String(body.description).slice(0, 300)
  }
  if (body.amount !== undefined) {
    const amount = Math.round(Number(body.amount))
    if (!Number.isFinite(amount) || amount < 0 || amount > 100_000_000) {
      return NextResponse.json({ error: 'bad_request', message: 'amount must be 0–100000 paise.' }, { status: 400 })
    }
    data.amount = amount
  }
  if (body.originalAmount !== undefined) {
    const oa = Number(body.originalAmount)
    data.originalAmount = Number.isFinite(oa) && oa > 0 ? Math.round(oa) : null
  }
  if (body.durationDays !== undefined) {
    const d = Math.round(Number(body.durationDays))
    if (!Number.isFinite(d) || d < 1 || d > MAX_DURATION_DAYS) {
      return NextResponse.json({ error: 'bad_request', message: `durationDays must be 1–${MAX_DURATION_DAYS}.` }, { status: 400 })
    }
    data.durationDays = d
  }
  if (body.badge !== undefined) {
    data.badge = typeof body.badge === 'string' && body.badge.trim() ? body.badge.trim().slice(0, 24) : null
  }
  if (body.features !== undefined) {
    const features = Array.isArray(body.features) ? body.features.map(f => String(f).slice(0, 120)).filter(Boolean).slice(0, 12) : []
    data.featuresJson = JSON.stringify(features)
  }
  if (body.active !== undefined) data.active = Boolean(body.active)
  if (body.visible !== undefined) data.visible = Boolean(body.visible)
  if (body.archived !== undefined) data.archived = Boolean(body.archived)
  if (body.displayOrder !== undefined) {
    const o = Math.round(Number(body.displayOrder))
    if (!Number.isFinite(o)) return NextResponse.json({ error: 'bad_request', message: 'displayOrder must be a number.' }, { status: 400 })
    data.displayOrder = o
  }

  // Safety: a plan can only be deactivated when at least one other active
  // plan remains — checkout always needs a purchasable option.
  if (data.active === false && plan.active) {
    const otherActive = await db.plan.count({ where: { id: { not: id }, active: true, archived: false } })
    if (otherActive === 0) {
      return NextResponse.json({ error: 'last_active_plan', message: 'Cannot disable the only active plan — add another plan first.' }, { status: 409 })
    }
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: 'bad_request', message: 'No supported fields to update.' }, { status: 400 })
  }

  try {
    const updated = await db.plan.update({ where: { id }, data })
    await writeAudit({
      action: data.archived === true && !plan.archived ? 'plan.archive' : data.active === false ? 'plan.disable' : data.active === true ? 'plan.enable' : 'plan.update',
      actorId: session.user.discordId,
      actorName: session.user.username,
      targetType: 'plan',
      targetId: plan.id,
      targetLabel: plan.name,
      before: planView(plan),
      after: planView(updated),
      reason: typeof body.reason === 'string' ? body.reason : null,
    })
    return NextResponse.json({ ok: true, plan: planView(updated) })
  } catch (e) {
    console.error('[admin/plans] update failed:', e)
    return NextResponse.json({ error: 'update_failed', message: 'Could not update the plan.' }, { status: 500 })
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireAdmin()
  if (error) return error
  const limited = adminRateLimited(req, 'plans-write')
  if (limited) return limited

  const { id } = await params
  const plan = await db.plan.findUnique({ where: { id } })
  if (!plan) return NextResponse.json({ error: 'not_found', message: 'Plan not found.' }, { status: 404 })

  // Delete only when nothing references the plan — otherwise archive keeps
  // purchase history + active subscriptions consistent.
  const [paymentCount, subCount] = await Promise.all([
    db.payment.count({ where: { plan: plan.slug } }),
    db.subscription.count({ where: { plan: plan.slug } }),
  ])
  if (paymentCount > 0 || subCount > 0) {
    return NextResponse.json({
      error: 'plan_in_use',
      message: `This plan is referenced by ${paymentCount} payment(s) and ${subCount} subscription(s) — archive it instead of deleting (history stays intact).`,
    }, { status: 409 })
  }

  try {
    await db.plan.delete({ where: { id } })
    await writeAudit({
      action: 'plan.delete',
      actorId: session.user.discordId,
      actorName: session.user.username,
      targetType: 'plan',
      targetId: plan.id,
      targetLabel: plan.name,
      before: planView(plan),
      reason: 'unused plan removed',
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[admin/plans] delete failed:', e)
    return NextResponse.json({ error: 'delete_failed', message: 'Could not delete the plan.' }, { status: 500 })
  }
}
