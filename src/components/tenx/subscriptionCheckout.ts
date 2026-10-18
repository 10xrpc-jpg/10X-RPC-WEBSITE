'use client'

// 10X RPC — client helper for Razorpay Checkout.js.
//
//   startPlanCheckout('plus'|'pro') →
//     1. POST /api/subscription/checkout → { keyId, orderId, amount, … }
//     2. loads https://checkout.razorpay.com/v1/checkout.js once
//     3. opens the Razorpay payment sheet (UPI / cards / netbanking)
//     4. on success POST /api/subscription/verify → subscription activated
//
// Callbacks keep the calling component in charge of toasts/refresh.
import { api } from '@/lib/api-client'

interface RazorpayOptions {
  key: string
  order_id: string
  amount: number
  currency: string
  name: string
  description?: string
  prefill?: { name?: string }
  theme?: { color?: string }
  handler?: (response: {
    razorpay_order_id: string
    razorpay_payment_id: string
    razorpay_signature: string
  }) => void
  modal?: { ondismiss?: () => void }
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => { open: () => void }
  }
}

let scriptPromise: Promise<boolean> | null = null

function loadCheckoutScript(): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false)
  if (window.Razorpay) return Promise.resolve(true)
  if (!scriptPromise) {
    scriptPromise = new Promise<boolean>((resolve) => {
      const s = document.createElement('script')
      s.src = 'https://checkout.razorpay.com/v1/checkout.js'
      s.async = true
      s.onload = () => resolve(true)
      s.onerror = () => {
        scriptPromise = null // allow a retry on the next click
        resolve(false)
      }
      document.body.appendChild(s)
    })
  }
  return scriptPromise
}

export interface CheckoutCallbacks {
  prefillName?: string | null
  onSuccess?: (info: { planLabel: string; lifted: boolean }) => void
  onError?: (message: string) => void
  onDismiss?: () => void
}

/** session storage key for a purchase started before Discord OAuth login —
 *  consumed + cleared by consumePendingPlanCheckout after authentication. */
const PENDING_PLAN_KEY = 'tenx:buy_plan'

/** Remember a Buy Now click from a logged-out visitor so the checkout can
 *  resume right after the Discord OAuth round-trip (sessionStorage survives
 *  the redirect chain in the same tab). */
export function savePendingPlanCheckout(plan: string): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(PENDING_PLAN_KEY, plan)
  } catch {
    // storage unavailable — user just logs in and clicks Buy again
  }
}

/** If a logged-out visitor clicked Buy Now before OAuth, finish what they
 *  started: clear the saved intent (always, to prevent loops) and open the
 *  Razorpay sheet for it. Returns the plan being opened, or null. */
export function consumePendingPlanCheckout(callbacks: CheckoutCallbacks = {}): string | null {
  if (typeof window === 'undefined') return null
  let plan: string | null = null
  try {
    plan = window.sessionStorage.getItem(PENDING_PLAN_KEY)
    window.sessionStorage.removeItem(PENDING_PLAN_KEY)
  } catch {
    return null
  }
  if (!plan) return null
  // Defer a tick — toasts fired during the first commit pass race the sonner
  // portal mount and never render.
  window.setTimeout(() => { void startPlanCheckout(plan as string, callbacks) }, 120)
  return plan
}

function periodLabel(days?: number): string {
  if (!days || days <= 0) return ''
  if (days >= 28 && days % 28 === 0) {
    const months = Math.round(days / 28)
    return ` / ${months} month${months === 1 ? '' : 's'}`
  }
  return ` / ${days} day${days === 1 ? '' : 's'}`
}

export async function startPlanCheckout(plan: string, callbacks: CheckoutCallbacks = {}): Promise<void> {
  const fail = (message: string) => callbacks.onError?.(message)

  let checkout
  try {
    checkout = await api.subscriptionCheckout(plan)
  } catch (err) {
    fail(err instanceof Error ? err.message : 'Could not start the payment.')
    return
  }
  if (!checkout.ok || !checkout.orderId) {
    fail(checkout.message || 'Could not start the payment.')
    return
  }

  const ready = await loadCheckoutScript()
  if (!ready || !window.Razorpay) {
    fail('Payment sheet failed to load — check your connection and retry.')
    return
  }

  const planLabel = checkout.planLabel || plan
  const inr = `₹${(checkout.amount / 100).toLocaleString('en-IN')}`
  const description = `${planLabel} — ${inr}${periodLabel(checkout.periodDays)}`
  const rzp = new window.Razorpay({
    key: checkout.keyId,
    order_id: checkout.orderId,
    amount: checkout.amount,
    currency: checkout.currency,
    name: '10X RPC',
    description,
    prefill: callbacks.prefillName ? { name: callbacks.prefillName } : undefined,
    theme: { color: '#f59e0b' },
    handler: (response) => {
      api
        .subscriptionVerify(response)
        .then((res) => {
          if (res.ok) {
            callbacks.onSuccess?.({ planLabel, lifted: !!res.lifted })
          } else {
            fail(res.message || 'Payment verification failed — contact support with your payment id.')
          }
        })
        .catch(() => fail('Payment verification failed — contact support with your payment id.'))
    },
    modal: { ondismiss: () => callbacks.onDismiss?.() },
  })
  rzp.open()
}
