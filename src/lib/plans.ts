// 10X RPC — Plan catalog (DB-backed, admin-managed).
//
// The pricing page + checkout resolve everything from the Plan table so
// prices, durations, badges and features can change without a deploy.
// Seeding is idempotent: the first read after this ships creates the two
// launch plans (plus / pro) from CONFIG.razorpay.plans so existing behavior
// is preserved exactly. Payment rows snapshot what was purchased, so later
// plan edits never rewrite history or reprice active entitlements.
import { db } from '@/lib/db'
import { CONFIG } from '@/lib/config'

export type PlanSlug = string

/** Serializable plan shape used across API + UI. */
export interface PlanView {
  id: string
  slug: string
  name: string
  description: string | null
  /** Paise (INR). */
  amount: number
  /** Paise — struck-through "was" price (offers). Null = none. */
  originalAmount: number | null
  durationDays: number
  badge: string | null
  features: string[]
  active: boolean
  visible: boolean
  displayOrder: number
  trial: boolean
  archived: boolean
  createdAt: string
  updatedAt: string
}

type PlanRow = {
  id: string
  slug: string
  name: string
  description: string | null
  amount: number
  originalAmount: number | null
  durationDays: number
  badge: string | null
  featuresJson: string
  active: boolean
  visible: boolean
  displayOrder: number
  trial: boolean
  archived: boolean
  createdAt: Date
  updatedAt: Date
}

export function planView(p: PlanRow): PlanView {
  let features: string[] = []
  try {
    const parsed = JSON.parse(p.featuresJson || '[]')
    if (Array.isArray(parsed)) features = parsed.map(String).filter(Boolean)
  } catch {
    // malformed JSON — treat as no features
  }
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    description: p.description,
    amount: p.amount,
    originalAmount: p.originalAmount,
    durationDays: p.durationDays,
    badge: p.badge,
    features,
    active: p.active,
    visible: p.visible,
    displayOrder: p.displayOrder,
    trial: p.trial,
    archived: p.archived,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  }
}

/** Launch plans derived from the Razorpay CONFIG block (seed source of truth). */
function defaultPlanRows(): { slug: string; name: string; amount: number; originalAmount: number | null; durationDays: number; badge: string | null; features: string[]; displayOrder: number }[] {
  const plus = CONFIG.razorpay.plans.plus
  const pro = CONFIG.razorpay.plans.pro
  return [
    {
      slug: 'plus',
      name: plus.label,
      amount: plus.amount,
      originalAmount: null,
      durationDays: plus.periodDays,
      badge: null,
      features: ['Full feature access', 'Standard Support', 'Basic discord role'],
      displayOrder: 2,
    },
    {
      slug: 'pro',
      name: `${pro.label} (3 Months)`,
      amount: pro.amount,
      originalAmount: 49900,
      durationDays: pro.periodDays,
      badge: '20% OFF',
      features: ['Full feature Access', 'Priority Support', 'Game RPC Requests', 'Custom discord role'],
      displayOrder: 1,
    },
  ]
}

let seeded = false

/** Idempotent seed — creates plus/pro from CONFIG only if the table is empty. */
export async function ensurePlansSeeded(): Promise<void> {
  if (seeded) return
  try {
    const count = await db.plan.count()
    if (count === 0) {
      for (const p of defaultPlanRows()) {
        await db.plan.create({
          data: {
            slug: p.slug,
            name: p.name,
            amount: p.amount,
            originalAmount: p.originalAmount,
            durationDays: p.durationDays,
            badge: p.badge,
            featuresJson: JSON.stringify(p.features),
            displayOrder: p.displayOrder,
            active: true,
            visible: true,
          },
        }).catch(() => {}) // unique race — another instance seeded first
      }
    }
    seeded = true
  } catch {
    // DB unavailable — checkout falls back to CONFIG plans below.
  }
}

/** Plans shown on the public pricing page (visible + active, not archived). */
export async function listPublicPlans(): Promise<PlanView[]> {
  await ensurePlansSeeded()
  const rows = await db.plan.findMany({
    where: { visible: true, active: true, archived: false },
    orderBy: [{ displayOrder: 'asc' }, { amount: 'desc' }],
  })
  return rows.map(planView)
}

/** Everything for the admin Plans tab (including archived/invisible). */
export async function listAllPlans(): Promise<PlanView[]> {
  await ensurePlansSeeded()
  const rows = await db.plan.findMany({
    orderBy: [{ archived: 'asc' }, { displayOrder: 'asc' }, { amount: 'desc' }],
  })
  return rows.map(planView)
}

/**
 * Resolve a purchasable plan by slug: DB first (active, not archived), then
 * the static CONFIG fallback so checkout keeps working even if the table is
 * unreachable. Returns null for unknown/disabled plans.
 */
export async function resolvePaidPlan(slug: string): Promise<{ slug: string; label: string; amount: number; durationDays: number } | null> {
  await ensurePlansSeeded()
  try {
    const row = await db.plan.findUnique({ where: { slug } })
    if (row && row.active && !row.archived) {
      return { slug: row.slug, label: row.name, amount: row.amount, durationDays: row.durationDays }
    }
    if (row && (!row.active || row.archived)) return null
  } catch {
    // fall through to CONFIG
  }
  const fallback = (CONFIG.razorpay.plans as Record<string, { label: string; amount: number; periodDays: number }>)[slug]
  if (fallback) return { slug, label: fallback.label, amount: fallback.amount, durationDays: fallback.periodDays }
  return null
}

/** Format paise as a ₹ display string (₹399 / ₹199). */
export function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN')}`
}
