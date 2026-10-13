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
// Uses raw fetch against api.razorpay.com — no SDK dependency, works on
// Vercel edge/node runtimes alike.
import crypto from 'crypto'
import { CONFIG } from '@/lib/config'

export type PaidPlan = 'plus' | 'pro'

export function razorpayConfigured(): boolean {
  return !!CONFIG.razorpay.keyId && !!CONFIG.razorpay.keySecret
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

function authHeader(): string {
  return `Basic ${Buffer.from(`${CONFIG.razorpay.keyId}:${CONFIG.razorpay.keySecret}`).toString('base64')}`
}

/** Server-to-server GET/POST against the Razorpay API. */
export async function rzpApi<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`${CONFIG.razorpay.apiBase}${path}`, {
    method: init?.method || 'GET',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
    cache: 'no-store',
  })
  const json = (await res.json().catch(() => ({}))) as T & { error?: { description?: string } }
  if (!res.ok) {
    throw new Error(json?.error?.description || `razorpay_api_${res.status}`)
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
      receipt: `sub:${userId.slice(-12)}:${plan}:${Date.now().toString(36)}`,
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
 *   HMAC_SHA256(`${order_id}|${payment_id}`, key_secret) — base64url? no,
 *   plain hex, compared with razorpay_signature. Constant-time compare.
 */
export function verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean {
  const expected = crypto
    .createHmac('sha256', CONFIG.razorpay.keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'))
  } catch {
    return false
  }
}

/** Webhook signature: HMAC_SHA256(raw_body, webhook_secret), hex. */
export function verifyWebhookSignature(rawBody: string, signature: string): boolean {
  if (!CONFIG.razorpay.webhookSecret || !signature) return false
  const expected = crypto.createHmac('sha256', CONFIG.razorpay.webhookSecret).update(rawBody).digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'))
  } catch {
    return false
  }
}
