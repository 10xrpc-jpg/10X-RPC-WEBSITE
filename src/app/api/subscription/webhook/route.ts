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
import { verifyWebhookSignature } from '@/lib/razorpay'
import { resolvePaidPlan } from '@/lib/plans'
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
  if (!(await verifyWebhookSignature(raw, signature))) {
    return NextResponse.json({ error: 'bad_signature' }, { status: 400 })
  }

  let event: WebhookPayload = {}
  try {
    event = JSON.parse(raw) as WebhookPayload
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }

  // Failed payments: mark the ledger row failed so dashboards show the
  // truth — the subscription is NEVER touched here.
  if (event.event === 'payment.failed') {
    const failed = event.payload?.payment?.entity
    if (failed?.order_id) {
      await db.payment.updateMany({
        where: { orderId: failed.order_id, status: 'created' },
        data: { status: 'failed' },
      }).catch(() => {})
    }
    return NextResponse.json({ ok: true, handled: 'payment.failed' })
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
  // checkout; the Payment ledger row + its snapshots are the source of truth
  // here — plan edits never reprice or shorten what was purchased).
  const order = payment.order_id ? await db.payment.findUnique({ where: { orderId: payment.order_id } }) : null
  const plan = (order?.plan || payment.notes?.plan || '') as string
  const userId = order?.userId || payment.notes?.userId || ''
  const p = await resolvePaidPlan(plan)
  const periodDays = order?.periodDays ?? p?.durationDays ?? 30
  if (!p || !userId) {
    // Order we never created (or notes lost) — acknowledge so Razorpay stops
    // retrying; nothing we can safely activate.
    return NextResponse.json({ ok: true, ignored: 'unknown_order' })
  }

  await db.payment.upsert({
    where: { orderId: payment.order_id || `wh:${payment.id}` },
    create: { userId, orderId: payment.order_id || `wh:${payment.id}`, paymentId: payment.id, plan, amount: payment.amount || p.amount, currency: 'INR', status: 'paid', planLabel: order?.planLabel ?? p.label, periodDays },
    update: { paymentId: payment.id, status: 'paid' },
  })
  const { lifted } = await activatePaidSubscription(userId, plan, periodDays)

  return NextResponse.json({ ok: true, plan, lifted })
}
