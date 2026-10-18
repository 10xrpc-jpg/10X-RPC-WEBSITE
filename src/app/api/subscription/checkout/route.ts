// 10X RPC — POST /api/subscription/checkout — create a Razorpay order for a
// paid plan (plus / pro / any active DB plan). Returns the public key +
// order id for Checkout.js. The order's notes carry userId/plan server-side,
// so the verify/webhook paths never trust the browser about who paid for
// what. Price/duration come from the admin-managed Plan table (CONFIG is
// only a fallback) and are snapshotted onto the Payment ledger row, so
// later plan edits never reprice an in-flight or historical purchase.
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { CONFIG } from '@/lib/config'
import { createSubscriptionOrder, fetchOrder, razorpayConfigured } from '@/lib/razorpay'
import { resolvePaidPlan } from '@/lib/plans'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

  if (!razorpayConfigured()) {
    return NextResponse.json({ error: 'payments_unavailable', message: 'Payments are temporarily unavailable — renew on Discord.' }, { status: 503 })
  }

  let body: { plan?: string } = {}
  try {
    body = (await request.json()) as { plan?: string }
  } catch {
    // fallthrough → invalid plan below
  }
  const planSlug = (body.plan || '').toLowerCase()
  // Server-side price/duration authority: the DB plan catalog (with CONFIG
  // fallback). The browser never gets to name its own price.
  const plan = await resolvePaidPlan(planSlug)
  if (!plan) {
    return NextResponse.json({ error: 'invalid_plan', message: 'That plan is not available — pick one from the pricing page.' }, { status: 400 })
  }

  try {
    // Duplicate-order guard: retrying Buy Now (double-click, sheet dismissed,
    // page reload) reuses the same still-open Razorpay order instead of
    // stacking a fresh pending order per click. The order must still exist
    // on Razorpay AND still be open — otherwise fall through and create new.
    const pending = await db.payment.findFirst({
      where: { userId: session.userId, plan: plan.slug, status: 'created', provider: 'razorpay' },
      orderBy: { createdAt: 'desc' },
    })
    if (pending) {
      try {
        const existing = await fetchOrder(pending.orderId)
        if (existing.status === 'created') {
          return NextResponse.json({
            ok: true,
            keyId: CONFIG.razorpay.keyId,
            orderId: existing.id,
            amount: existing.amount,
            currency: existing.currency || CONFIG.razorpay.currency,
            plan: plan.slug,
            planLabel: pending.planLabel || plan.label,
            periodDays: pending.periodDays ?? plan.durationDays,
          })
        }
      } catch {
        // Order vanished on Razorpay (rotated keys, test cleanup) — retire the
        // stale ledger row so a fresh order can be created below.
        await db.payment.update({ where: { id: pending.id }, data: { status: 'abandoned' } }).catch(() => {})
      }
    }

    const order = await createSubscriptionOrder(session.userId, plan.slug, plan.amount, plan.label, session.user.username || null)
    // Ledger row (status "created" → "paid" on verify/webhook). planLabel /
    // periodDays snapshot the purchased entitlement at checkout time.
    await db.payment.upsert({
      where: { orderId: order.id },
      create: {
        userId: session.userId, orderId: order.id, plan: plan.slug, amount: order.amount,
        currency: order.currency || CONFIG.razorpay.currency, status: 'created',
        planLabel: plan.label, periodDays: plan.durationDays,
      },
      update: { plan: plan.slug, amount: order.amount, status: 'created', planLabel: plan.label, periodDays: plan.durationDays },
    })
    return NextResponse.json({
      ok: true,
      keyId: CONFIG.razorpay.keyId,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency || CONFIG.razorpay.currency,
      plan: plan.slug,
      planLabel: plan.label,
      periodDays: plan.durationDays,
    })
  } catch (err) {
    console.error('[subscription/checkout] razorpay order failed:', err)
    return NextResponse.json({ error: 'order_failed', message: 'Could not start the payment — try again or renew on Discord.' }, { status: 502 })
  }
}
