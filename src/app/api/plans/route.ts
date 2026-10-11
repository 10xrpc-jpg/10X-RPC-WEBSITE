// 10X RPC — GET /api/plans — public pricing catalog.
// Everything the landing page renders comes from the admin-managed Plan
// table (visible + active, ordered); the free-trial card is synthesized
// from the trial policy. No secrets, no auth — safe to call from the hero.
import { NextResponse } from 'next/server'
import { listPublicPlans } from '@/lib/plans'
import { getTrialConfig } from '@/lib/trial-config'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const [plans, trial] = await Promise.all([listPublicPlans(), getTrialConfig()])
    return NextResponse.json({
      ok: true,
      currency: 'INR',
      plans: plans.map(p => ({
        slug: p.slug,
        name: p.name,
        description: p.description,
        amount: p.amount,
        originalAmount: p.originalAmount,
        durationDays: p.durationDays,
        badge: p.badge,
        features: p.features,
        displayOrder: p.displayOrder,
      })),
      trial: {
        enabled: trial.enabled && trial.days > 0,
        days: trial.days,
        name: trial.name,
        description: trial.description,
        features: trial.features,
      },
    })
  } catch {
    // DB unavailable — the landing page falls back to its static pricing.
    return NextResponse.json({ ok: false, plans: [], trial: null }, { status: 200 })
  }
}
