// 10X RPC — POST /api/subscription/checkout — create a Razorpay order for a
// paid plan (plus / pro). Returns the public key + order id for Checkout.js.
// The order's notes carry userId/plan server-side, so the verify/webhook
// paths never trust the browser about who paid for what.
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { CONFIG } from '@/lib/config'
import { createSubscriptionOrder, getPlan, razorpayConfigured, type PaidPlan } from '@/lib/razorpay'

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
  const plan = (body.plan || '').toLowerCase() as PaidPlan
  const p = getPlan(plan)
  if (!p) {
    return NextResponse.json({ error: 'invalid_plan', message: 'Choose the Plus or Pro plan.' }, { status: 400 })
  }

  try {
    const order = await createSubscriptionOrder(session.userId, plan, session.user.username || null)
    // Ledger row (status "created" → "paid" on verify/webhook).
    await db.payment.upsert({
      where: { orderId: order.id },
      create: { userId: session.userId, orderId: order.id, plan, amount: order.amount, currency: order.currency || CONFIG.razorpay.currency, status: 'created' },
      update: { plan, amount: order.amount, status: 'created' },
    })
    return NextResponse.json({
      ok: true,
      keyId: CONFIG.razorpay.keyId,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency || CONFIG.razorpay.currency,
      plan,
      planLabel: p.label,
    })
  } catch (err) {
    console.error('[subscription/checkout] razorpay order failed:', err)
    return NextResponse.json({ error: 'order_failed', message: 'Could not start the payment — try again or renew on Discord.' }, { status: 502 })
  }
}
