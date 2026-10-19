// 10X RPC — Razorpay server helpers (orders, signature verification).
//
//   checkout flow:  POST /api/subscription/checkout  → Razorpay Order created
//                   (client opens Checkout.js with the order id)
//   verify flow:    POST /api/subscription/verify      → HMAC(order|payment)
//                   check + Razorpay payment fetch → subscription activated
//   webhook flow:   POST /api/subscription/webhook    → x-razorpay-signature
//                   check over the raw body → idempotent activation (backup
//                   path when the browser closes before /verify runs)
//
// Credentials resolve through getRazorpayKeys() (env primary + admin DB
// override — see src/lib/razorpay-config.ts) so a stale/mis-pasted Vercel key
// can be replaced from the dashboard without a redeploy. Transient Razorpay
// failures (network blips, 5xx) are retried once; 4xx responses are
// deterministic and fail fast with their exact error description logged.
//
// Uses raw fetch against api.razorpay.com — no SDK dependency, works on
// Vercel edge/node runtimes alike.
import crypto from 'crypto'
import { getRazorpayKeys } from '@/lib/razorpay-config'
import { CONFIG } from '@/lib/config'

export type PaidPlan = 'plus' | 'pro'

/** True when the resolved credentials (env or admin override) are complete. */
export async function razorpayConfigured(): Promise<boolean> {
  const keys = await getRazorpayKeys()
  return !!keys.keyId && !!keys.keySecret
}

export function getPlan(plan: string) {
  if (plan === 'plus' || plan === 'pro') return CONFIG.razorpay.plans[plan]
  return null
}

export interface RazorpayOrder {
  id: string
  amount: number
  currency: string
  status: string
  receipt?: string
  notes?: Record<string, string>
}

export interface RazorpayPayment {
  id: string
  order_id: string
  amount: number
  status: string
  method?: string
  notes?: Record<string, string>
  error_description?: string
}

export class RazorpayApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'RazorpayApiError'
    this.status = status
  }
}

function authHeader(keyId: string, keySecret: string): string {
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`
}

/** Server-to-server GET/POST against the Razorpay API. Transient failures
 *  (network throw, 500/502/503/504) retry once; 4xx fails immediately —
 *  those are deterministic (bad key, bad request) and retrying only hides
 *  the real cause. */
export async function rzpApi<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const keys = await getRazorpayKeys()
  const doFetch = async (): Promise<Response> =>
    fetch(`${CONFIG.razorpay.apiBase}${path}`, {
      method: init?.method || 'GET',
      headers: {
        Authorization: authHeader(keys.keyId, keys.keySecret),
        'Content-Type': 'application/json',
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
      cache: 'no-store',
    })

  let res: Response
  try {
    res = await doFetch()
  } catch (err) {
    // Network-level failure — worth exactly one retry (Vercel ↔ Razorpay
    // blips happen; a dropped DNS/TLS handshake must not kill a checkout).
    await new Promise(r => setTimeout(r, 400))
    try {
      res = await doFetch()
    } catch (retryErr) {
      throw new RazorpayApiError(`razorpay_network_error: ${(retryErr as Error)?.message || 'unreachable'}`, 0)
    }
  }

  const json = (await res.json().catch(() => ({}))) as T & { error?: { description?: string } }
  if (!res.ok) {
    const description = json?.error?.description || `razorpay_api_${res.status}`
    if (res.status >= 500 && res.status <= 504) {
      // One retry for upstream hiccups, then surface the exact failure.
      await new Promise(r => setTimeout(r, 400))
      try {
        const retry = await doFetch()
        const retryJson = (await retry.json().catch(() => ({}))) as T & { error?: { description?: string } }
        if (retry.ok) return retryJson
        throw new RazorpayApiError(retryJson?.error?.description || `razorpay_api_${retry.status}`, retry.status)
      } catch (e) {
        if (e instanceof RazorpayApiError) throw e
        throw new RazorpayApiError(`razorpay_network_error: ${(e as Error)?.message || 'unreachable'}`, 0)
      }
    }
    throw new RazorpayApiError(description, res.status)
  }
  return json
}

/** Create a Razorpay order for a paid plan. Notes carry the user/plan so
 *  verify/webhook can activate the right subscription without trusting the
 *  client. Amount/label come from the admin-managed Plan catalog (checked
 *  out server-side) — the browser never names its own price. */
export async function createSubscriptionOrder(
  userId: string,
  plan: string,
  amount: number,
  planLabel?: string | null,
  userName?: string | null,
): Promise<RazorpayOrder> {
  return rzpApi<RazorpayOrder>('/orders', {
    method: 'POST',
    body: {
      amount,
      currency: CONFIG.razorpay.currency,
      // Random suffix per attempt: a retried order can never collide with
      // Razorpay's "receipt already exists" rejection. Double-ordering is
      // prevented by the checkout route's pending-order reuse, not here.
      receipt: `sub:${userId.slice(-12)}:${plan}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      notes: {
        userId,
        plan,
        ...(planLabel ? { planLabel } : {}),
        source: '10x-rpc-web',
        ...(userName ? { userName } : {}),
      },
    },
  })
}

export function fetchOrder(orderId: string): Promise<RazorpayOrder> {
  return rzpApi<RazorpayOrder>(`/orders/${encodeURIComponent(orderId)}`)
}

export function fetchPayment(paymentId: string): Promise<RazorpayPayment> {
  return rzpApi<RazorpayPayment>(`/payments/${encodeURIComponent(paymentId)}`)
}

/**
 * Razorpay Checkout.js handler signature:
 *   HMAC_SHA256(`${order_id}|${payment_id}`, key_secret) — plain hex,
 *   compared with razorpay_signature. Constant-time compare.
 */
export async function verifyPaymentSignature(orderId: string, paymentId: string, signature: string): Promise<boolean> {
  const keys = await getRazorpayKeys()
  if (!keys.keySecret || !signature) return false
  const expected = crypto
    .createHmac('sha256', keys.keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'))
  } catch {
    return false
  }
}

/** Webhook signature: HMAC_SHA256(raw_body, webhook_secret), hex. */
export async function verifyWebhookSignature(rawBody: string, signature: string): Promise<boolean> {
  const keys = await getRazorpayKeys()
  if (!keys.webhookSecret || !signature) return false
  const expected = crypto.createHmac('sha256', keys.webhookSecret).update(rawBody).digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'))
  } catch {
    return false
  }
}
