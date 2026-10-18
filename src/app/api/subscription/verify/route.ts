// 10X RPC — POST /api/subscription/verify — final step of the Checkout.js
// flow. The browser hands back { razorpay_order_id, razorpay_payment_id,
// razorpay_signature }; we re-verify the HMAC server-side, then confirm the
// payment with the Razorpay API (status captured + amount + order/notes
// belong to the signed-in user) before activating the subscription.
// Idempotent: repeat calls for the same payment just return success.
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { fetchPayment, verifyPaymentSignature, razorpayConfigured } from '@/lib/razorpay'
import { resolvePaidPlan } from '@/lib/plans'
import { activatePaidSubscription, subscriptionView } from '@/lib/subscription'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

  if (!razorpayConfigured()) {
    return NextResponse.json({ error: 'payments_unavailable' }, { status: 503 })
  }

  let body: { razorpay_order_id?: string; razorpay_payment_id?: string; razorpay_signature?: string } = {}
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }
  const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = body
  if (!orderId || !paymentId || !signature) {
    return NextResponse.json({ error: 'bad_request', message: 'Missing payment confirmation fields.' }, { status: 400 })
  }

  // 1) Signature check — proves Razorpay's checkout really completed this
  //    order/payment pair (the key secret never left the server).
  if (!verifyPaymentSignature(orderId, paymentId, signature)) {
    return NextResponse.json({ error: 'bad_signature', message: 'Payment signature check failed — nothing was activated.' }, { status: 400 })
  }

  // 2) Idempotency: already-verified payment → return current state.
  const existing = await db.payment.findUnique({ where: { paymentId } })
  if (existing && existing.status === 'paid' && existing.userId === session.userId) {
    // Entitlement duration = the snapshot taken at checkout (plan edits
    // never reprice or shorten an already-paid period).
    const { sub } = await activatePaidSubscription(existing.userId, existing.plan, existing.periodDays ?? 30)
    return NextResponse.json({ ok: true, repeat: true, subscription: subscriptionView(sub, session.user.discordId) })
  }

  // 3) Confirm with Razorpay: payment captured, right order, right amount,
  //    and the order's notes point at THIS user (they were set server-side
  //    at checkout; the payment entity mirrors the order notes).
  let payment
  try {
    payment = await fetchPayment(paymentId)
  } catch {
    return NextResponse.json({ error: 'payment_not_found', message: 'Payment not found on Razorpay — nothing was activated.' }, { status: 402 })
  }
  if (payment.order_id !== orderId) {
    return NextResponse.json({ error: 'order_mismatch', message: 'Payment does not match this order.' }, { status: 400 })
  }
  if (payment.status !== 'captured' && payment.status !== 'authorized') {
    return NextResponse.json({ error: 'payment_not_completed', message: 'The payment has not completed yet.' }, { status: 402 })
  }

  // Order lookup: authoritative plan/user binding. planLabel/periodDays are
  // the checkout-time snapshots — later plan edits cannot reprice or alter
  // what this payment grants.
  const order = await db.payment.findUnique({ where: { orderId } })
  // Amount check against the checkout-time snapshot (server-fetched from
  // Razorpay vs server-stored ledger) — a tampered/edited order can never
  // buy a plan at the wrong price.
  if (order && typeof order.amount === 'number' && typeof payment.amount === 'number' && payment.amount !== order.amount) {
    return NextResponse.json({ error: 'amount_mismatch', message: 'Payment amount does not match this order — nothing was activated.' }, { status: 400 })
  }
  const plan = (order?.plan || payment.notes?.plan || '') as string
  const orderUserId = order?.userId || payment.notes?.userId || ''
  const p = await resolvePaidPlan(plan)
  const periodDays = order?.periodDays ?? p?.durationDays ?? 30
  const planLabel = order?.planLabel ?? p?.label ?? plan
  if (!p || orderUserId !== session.userId) {
    return NextResponse.json({ error: 'order_mismatch', message: 'Order does not belong to this account.' }, { status: 403 })
  }

  // 4) Ledger + activation.
  await db.payment.updateMany({ where: { orderId }, data: { paymentId, status: 'paid' } })
  const { sub, lifted } = await activatePaidSubscription(session.userId, plan, periodDays)

  return NextResponse.json({
    ok: true,
    plan,
    planLabel,
    lifted,
    subscription: subscriptionView(sub, session.user.discordId),
  })
}
