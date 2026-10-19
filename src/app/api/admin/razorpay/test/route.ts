// 10X RPC — POST /api/admin/razorpay/test — live Razorpay connectivity probe.
//
// Runs the two calls that matter with the RESOLVED credentials (env or the
// admin override):
//   1. GET /payments?count=1   → does the key pair authenticate at all?
//   2. POST /orders (₹1 dummy) → can we actually create orders (the exact
//      call checkout uses)? An order never charges anyone — harmless.
// Returns the exact HTTP status + Razorpay error description for each, so
// "Could not start the payment" stops being a mystery: the admin sees
// precisely whether the keys are invalid, mode-mismatched, or fine.
import { NextResponse } from 'next/server'
import { requireAdmin, adminRateLimited, writeAudit } from '@/lib/admin-guard'
import { getRazorpayKeys } from '@/lib/razorpay-config'
import { CONFIG } from '@/lib/config'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

interface ProbeResult {
  ok: boolean
  status: number
  error?: string
  data?: Record<string, unknown>
}

async function probe(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ProbeResult> {
  const keys = await getRazorpayKeys()
  const auth = Buffer.from(`${keys.keyId}:${keys.keySecret}`).toString('base64')
  try {
    const res = await fetch(`${CONFIG.razorpay.apiBase}${path}`, {
      method,
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: { description?: string } }
    if (!res.ok) {
      return { ok: false, status: res.status, error: json?.error?.description || `HTTP ${res.status}` }
    }
    return { ok: true, status: res.status, data: json }
  } catch (e) {
    return { ok: false, status: 0, error: `network error: ${e instanceof Error ? e.message : 'unreachable'}` }
  }
}

export async function POST(request: Request) {
  const { session, error } = await requireAdmin()
  if (error) return error
  const limited = adminRateLimited(request, 'razorpay-test', 6, 60_000)
  if (limited) return limited

  const keys = await getRazorpayKeys()
  if (!keys.keyId || !keys.keySecret) {
    return NextResponse.json({
      ok: false,
      keyMode: 'none',
      auth: { ok: false, status: 0, error: 'No credentials configured — set Key Id + Key Secret below.' },
    })
  }

  const keyMode = keys.keyId.startsWith('rzp_test_') ? 'test' : keys.keyId.startsWith('rzp_live_') ? 'live' : 'unknown'

  // 1) Auth probe — list payments (read-only, no side effects).
  const auth = await probe('GET', '/payments?count=1')

  // 2) Order-creation probe — the exact call /api/subscription/checkout uses.
  //    ₹1 dummy order; creating an order never moves money.
  const order = await probe('POST', '/orders', {
    amount: 100,
    currency: CONFIG.razorpay.currency,
    receipt: `diag:${Date.now().toString(36)}`,
    notes: { source: '10x-rpc-admin-test', by: session.user.discordId },
  })

  const overallOk = auth.ok && order.ok

  await writeAudit({
    action: 'razorpay.connection_test',
    actorId: session.user.discordId,
    actorName: session.user.username,
    targetType: 'platform',
    targetId: 'razorpay',
    targetLabel: 'Payment Gateway credentials',
    after: { keyMode, authStatus: auth.status, orderStatus: order.status, ok: overallOk },
    outcome: overallOk ? 'ok' : 'error',
  })

  return NextResponse.json({
    ok: overallOk,
    keyMode,
    keyIdSource: keys.source.keyId,
    auth: { ok: auth.ok, status: auth.status, error: auth.error },
    order: { ok: order.ok, status: order.status, id: (order.data?.id as string) || null, error: order.error },
    hint: overallOk
      ? 'Credentials work end to end — Buy Now will open the Razorpay sheet.'
      : auth.status === 401
        ? 'Razorpay rejected these credentials (401 unauthorized). Re-copy the Key Id AND Key Secret from Razorpay Dashboard → Settings → API Keys, then Save.'
        : !auth.ok
          ? `Auth probe failed: ${auth.error || `HTTP ${auth.status}`}`
          : `Auth works but order creation failed: ${order.error || `HTTP ${order.status}`}`,
    testedAt: new Date().toISOString(),
  })
}
