// 10X RPC — Subscription lifecycle (single source of truth for user access)
//
//   New user  → plan "free", status "trialing" (CONFIG.app.trialDays = 3 days).
//   Trial ends (or a paid period ends) → the lazy sweep flips status to
//   "suspended", kills every session's RPC flags and stops presence.
//   Renewal = an admin grant (pro/plus/lifetime) which flips status back to
//   "active". Admins (CONFIG.admin.discordIds) bypass gating entirely.
//
// The legacy Trial model/table is kept as a historical record but no longer
// gates anything. When a Subscription row is missing (every pre-existing
// user), ensureSubscription() bootstraps one from the legacy Trial:
//   • trial still active  → seed trialEndsAt from it (remaining time kept)
//   • trial already ended → status "suspended" (they renew to regain access)
import { db } from '@/lib/db'
import { CONFIG } from '@/lib/config'

export type SubscriptionPlan = 'free' | 'plus' | 'pro' | 'lifetime'
export type SubscriptionStatus = 'trialing' | 'active' | 'suspended'

/** Minimal shape needed to evaluate access (works with Prisma rows or raw rows). */
export interface SubscriptionLike {
  plan: string
  status: string
  trialEndsAt: Date | null
  currentPeriodEnd: Date | null
}

export function isSubscriptionAdmin(discordId: string | null | undefined): boolean {
  return !!discordId && CONFIG.admin.discordIds.includes(discordId)
}

export interface SubscriptionEvaluation {
  allowed: boolean
  /** When the CURRENT phase ends (trial or paid period). Null = never ends. */
  endsAt: Date | null
  msLeft: number
  daysLeft: number
}

/** Pure evaluation — no DB writes. Admins always allowed. */
export function evaluateSubscription(
  sub: SubscriptionLike | null | undefined,
  discordId?: string | null,
  now: Date = new Date(),
): SubscriptionEvaluation {
  if (isSubscriptionAdmin(discordId)) {
    return { allowed: true, endsAt: null, msLeft: Number.POSITIVE_INFINITY, daysLeft: Infinity }
  }
  if (!sub) return { allowed: false, endsAt: null, msLeft: 0, daysLeft: 0 }

  if (sub.status === 'trialing') {
    const endsAt = sub.trialEndsAt
    const msLeft = endsAt ? endsAt.getTime() - now.getTime() : 0
    return { allowed: msLeft > 0, endsAt, msLeft: Math.max(0, msLeft), daysLeft: Math.max(0, Math.ceil(msLeft / 86400000)) }
  }
  if (sub.status === 'active') {
    if (sub.plan === 'lifetime' || !sub.currentPeriodEnd) {
      return { allowed: true, endsAt: null, msLeft: Number.POSITIVE_INFINITY, daysLeft: Infinity }
    }
    const msLeft = sub.currentPeriodEnd.getTime() - now.getTime()
    return { allowed: msLeft > 0, endsAt: sub.currentPeriodEnd, msLeft: Math.max(0, msLeft), daysLeft: Math.max(0, Math.ceil(msLeft / 86400000)) }
  }
  // suspended (or unknown status) — denied
  return { allowed: false, endsAt: null, msLeft: 0, daysLeft: 0 }
}

/**
 * Find or create the user's Subscription row. Bootstraps from the legacy
 * Trial when present (remaining trial time is preserved). Safe to call on
 * every request — it is one findUnique in the common case.
 */
export async function ensureSubscription(userId: string) {
  const existing = await db.subscription.findUnique({ where: { userId } })
  if (existing) return existing

  const legacy = await db.trial.findUnique({ where: { userId } }).catch(() => null)
  const now = new Date()
  const trialMs = CONFIG.app.trialDays * 24 * 60 * 60 * 1000

  if (legacy && legacy.endsAt > now) {
    // Pre-existing user with remaining (legacy 30-day) trial time — keep it.
    return db.subscription.create({
      data: { userId, plan: 'free', status: 'trialing', trialEndsAt: legacy.endsAt },
    })
  }
  if (legacy) {
    // Pre-existing user whose legacy trial already ended → suspended.
    return db.subscription.create({
      data: { userId, plan: 'free', status: 'suspended', trialEndsAt: legacy.endsAt, suspendedAt: now },
    })
  }
  // Brand-new user → 3-day free trial.
  return db.subscription.create({
    data: { userId, plan: 'free', status: 'trialing', trialEndsAt: new Date(now.getTime() + trialMs) },
  })
}

/**
 * Per-user sweep: ensure the row exists, transition to "suspended" when the
 * trial/period has ended, and (on transition) kill every session's RPC flags
 * + best-effort stop the live presence. Returns the fresh row + whether a
 * transition happened this call.
 */
export async function sweepSubscription(userId: string, discordId?: string | null): Promise<{ sub: NonNullable<Awaited<ReturnType<typeof ensureSubscription>>>; transitioned: boolean; allowed: boolean }> {
  let sub = await ensureSubscription(userId)
  if (isSubscriptionAdmin(discordId)) return { sub, transitioned: false, allowed: true }

  const ev = evaluateSubscription(sub, discordId)
  if (ev.allowed || sub.status === 'suspended') {
    return { sub, transitioned: false, allowed: ev.allowed }
  }

  const now = new Date()
  sub = await db.subscription.update({
    where: { userId },
    data: { status: 'suspended', suspendedAt: now },
  })
  // Kill RPC on every live session + clear presence (best-effort).
  await db.session.updateMany({
    where: { userId, expiresAt: { gt: now } },
    data: { rpcEnabled: false, statusEnabled: false, gatewayReady: false, vrStatusActive: false },
  }).catch(() => {})
  try {
    const { stopPresence } = await import('@/lib/presence-sync')
    await stopPresence(userId)
  } catch {
    // Presence backend unavailable — the DB flags already stop the daemon.
  }
  return { sub, transitioned: true, allowed: false }
}

/**
 * Bulk sweep for admin views: flips every expired trialing/active subscription
 * to suspended in two updateMany calls (RPC-flag cleanup happens lazily per
 * user, and the daemon also disconnects non-allowed users on its own tick).
 */
export async function sweepAllSubscriptions(): Promise<void> {
  const now = new Date()
  await db.subscription.updateMany({
    where: { status: 'trialing', trialEndsAt: { lt: now } },
    data: { status: 'suspended', suspendedAt: now },
  })
  await db.subscription.updateMany({
    where: { status: 'active', currentPeriodEnd: { lt: now } },
    data: { status: 'suspended', suspendedAt: now },
  })
}

/** Serializable subscription view for API responses. */
export function subscriptionView(
  sub: {
    plan: string
    status: string
    trialEndsAt: Date | null
    currentPeriodEnd: Date | null
    suspendedAt: Date | null
  },
  discordId?: string | null,
  now: Date = new Date(),
) {
  const ev = evaluateSubscription(sub, discordId, now)
  const admin = isSubscriptionAdmin(discordId)
  const finiteMsLeft = Number.isFinite(ev.msLeft) ? ev.msLeft : 0
  return {
    plan: sub.plan as SubscriptionPlan,
    status: (admin ? 'active' : sub.status) as SubscriptionStatus,
    trialEndsAt: sub.trialEndsAt ? sub.trialEndsAt.toISOString() : null,
    currentPeriodEnd: sub.currentPeriodEnd ? sub.currentPeriodEnd.toISOString() : null,
    suspendedAt: sub.suspendedAt ? sub.suspendedAt.toISOString() : null,
    endsAt: ev.endsAt ? ev.endsAt.toISOString() : null,
    msLeft: finiteMsLeft,
    daysLeft: Number.isFinite(ev.daysLeft) ? ev.daysLeft : 0,
    allowed: ev.allowed,
    neverExpires: !Number.isFinite(ev.msLeft),
    /** True when this user bypasses gating via ADMIN_DISCORD_IDS. */
    admin,
  }
}

/**
 * Activate/extend a paid plan (Razorpay verify + webhook share this path).
 * Idempotent: safe to run twice for the same payment. Period stacking — if
 * the user still has active paid time, the new period extends it; otherwise
 * it starts now. Also lifts any suspension. Returns the fresh row + whether
 * a suspension was lifted (for success messaging).
 */
export async function activatePaidSubscription(
  userId: string,
  plan: 'plus' | 'pro' | 'lifetime',
  periodDays: number,
): Promise<{ sub: NonNullable<Awaited<ReturnType<typeof ensureSubscription>>>; lifted: boolean }> {
  const current = await ensureSubscription(userId)
  const now = new Date()
  const add = periodDays * 24 * 60 * 60 * 1000
  const stacking = current.status === 'active' && current.currentPeriodEnd && current.currentPeriodEnd > now && plan !== 'lifetime'
  const base = stacking ? current.currentPeriodEnd!.getTime() : now.getTime()
  const sub = await db.subscription.update({
    where: { userId },
    data: {
      plan,
      status: 'active',
      suspendedAt: null,
      currentPeriodEnd: plan === 'lifetime' ? null : new Date(base + add),
    },
  })
  return { sub, lifted: current.status === 'suspended' }
}

/**
 * Gate helper for mutating RPC endpoints. Returns null when access is allowed,
 * otherwise a ready 403 JSON payload (error code + human message).
 */
export async function requireSubscriptionAccess(
  userId: string,
  discordId: string | null | undefined,
): Promise<{ error: string; message: string } | null> {
  const { sub, allowed } = await sweepSubscription(userId, discordId)
  if (allowed) return null
  const isTrial = sub.status === 'trialing' || sub.plan === 'free'
  return {
    error: isTrial ? 'trial_expired' : 'subscription_suspended',
    message: isTrial
      ? `Your ${CONFIG.app.trialDays}-day free trial has ended — your account is suspended. Renew to restore 24/7 RPC.`
      : 'Your subscription is suspended. Renew to restore 24/7 RPC.',
  }
}
