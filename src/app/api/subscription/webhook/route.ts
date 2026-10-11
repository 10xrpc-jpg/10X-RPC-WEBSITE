// 10X RPC — POST /api/subscription/webhook — Razorpay's server-to-server
// backup activation path. Covers the case where the payer closes the browser
// before /api/subscription/verify runs (or the network drops after payment).
//
// Security: the x-razorpay-signature header is HMAC_SHA256(raw_body,
// RAZORPAY_WEBHOOK_SECRET) — the body must be read as raw text BEFORE JSON
// parsing. Add this URL + the same secret in the Razorpay Dashboard →
// Settings → Webhooks (event: payment.captured).
//
// Idempotent: a paymentId already marked "paid" short-circuits to 200.
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyWebhookSignature, getPlan, type PaidPlan } from '@/lib/razorpay'
import { activatePaidSubscription } from '@/lib/subscription'

export const dynamic = 'force-dynamic'

interface WebhookPayload {
  event?: string
  payload?: {
    payment?: {
      entity?: {
        id?: string
        order_id?: string
        amount?: number
        status?: string
        notes?: Record<string, string>
      }
    }
  }
}

export async function POST(request: Request) {
  const raw = await request.text()
  const signature = request.headers.get('x-razorpay-signature') || ''
  if (!verifyWebhookSignature(raw, signature)) {
    return NextResponse.json({ error: 'bad_signature' }, { status: 400 })
  }

  let event: WebhookPayload = {}
  try {
    event = JSON.parse(raw) as WebhookPayload
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }
  // Order paid / payment captured are the two success signals Razorpay sends.
  if (event.event !== 'payment.captured' && event.event !== 'order.paid') {
    return NextResponse.json({ ok: true, ignored: event.event || 'unknown' })
  }

  const payment = event.payload?.payment?.entity
  if (!payment?.id) return NextResponse.json({ error: 'bad_request' }, { status: 400 })

  // Idempotency by paymentId.
  const existing = await db.payment.findUnique({ where: { paymentId: payment.id } })
  if (existing?.status === 'paid') return NextResponse.json({ ok: true, repeat: true })

  // Resolve the order → authoritative plan/user (created server-side at
  // checkout; the Payment ledger row is the source of truth here).
  const order = payment.order_id ? await db.payment.findUnique({ where: { orderId: payment.order_id } }) : null
  const plan = (order?.plan || payment.notes?.plan || '') as PaidPlan
  const userId = order?.userId || payment.notes?.userId || ''
  const p = getPlan(plan)
  if (!p || !userId) {
    // Order we never created (or notes lost) — acknowledge so Razorpay stops
    // retrying; nothing we can safely activate.
    return NextResponse.json({ ok: true, ignored: 'unknown_order' })
  }

  await db.payment.upsert({
    where: { orderId: payment.order_id || `wh:${payment.id}` },
    create: { userId, orderId: payment.order_id || `wh:${payment.id}`, paymentId: payment.id, plan, amount: payment.amount || p.amount, currency: 'INR', status: 'paid' },
    update: { paymentId: payment.id, status: 'paid' },
  })
  const { lifted } = await activatePaidSubscription(userId, plan, p.periodDays)

  return NextResponse.json({ ok: true, plan, lifted })
}
