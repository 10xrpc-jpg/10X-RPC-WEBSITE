// 10X RPC — /api/admin/trial-config — free-trial policy management.
//   GET — current policy + live trial stats (trialing / expired / users who
//         converted from trial to paid).
//   PUT — update the policy (enabled, days, name, description, features,
//         allowRepeat). Applies to NEW signups immediately; existing trials
//         keep their end date unless an admin adjusts them per user.
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getTrialConfig, setTrialConfig } from '@/lib/trial-config'
import { requireAdmin, adminRateLimited, writeAudit } from '@/lib/admin-guard'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { error } = await requireAdmin()
  if (error) return error

  try {
    const now = new Date()
    const [config, trialing, expired, converted] = await Promise.all([
      getTrialConfig(),
      db.subscription.count({ where: { status: 'trialing' } }),
      // Expired trials = suspended accounts that still carry a trialEndsAt
      // (suspended by time, not by an admin).
      db.subscription.count({
        where: { status: 'suspended', trialEndsAt: { not: null }, currentPeriodEnd: null },
      }),
      // Converted = accounts with at least one paid payment (trial → paid).
      db.payment.groupBy({ by: ['userId'], where: { status: 'paid' } }),
    ])
    return NextResponse.json({
      ok: true,
      config,
      stats: {
        trialing,
        expired,
        converted: converted.length,
      },
      checkedAt: now.toISOString(),
    })
  } catch (e) {
    console.error('[admin/trial-config] read failed:', e)
    return NextResponse.json({ error: 'unavailable', message: 'Could not load the trial policy.' }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  const { session, error } = await requireAdmin()
  if (error) return error
  const limited = adminRateLimited(req, 'trial-config')
  if (limited) return limited

  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const before = await getTrialConfig()

  try {
    const config = await setTrialConfig({
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      days: body.days !== undefined ? Number(body.days) : undefined,
      name: typeof body.name === 'string' ? body.name : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
      features: Array.isArray(body.features) ? body.features.map(f => String(f)) : undefined,
      allowRepeat: typeof body.allowRepeat === 'boolean' ? body.allowRepeat : undefined,
    })
    await writeAudit({
      action: 'trial.config_update',
      actorId: session.user.discordId,
      actorName: session.user.username,
      targetType: 'trial_config',
      targetId: 'trial',
      targetLabel: config.name,
      before,
      after: config,
      reason: typeof body.reason === 'string' ? body.reason : null,
    })
    return NextResponse.json({ ok: true, config })
  } catch (e) {
    console.error('[admin/trial-config] update failed:', e)
    return NextResponse.json({ error: 'update_failed', message: 'Could not save the trial policy.' }, { status: 500 })
  }
}
