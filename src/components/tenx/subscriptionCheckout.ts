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
import { api, type PaidPlanId } from '@/lib/api-client'

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

export async function startPlanCheckout(plan: PaidPlanId, callbacks: CheckoutCallbacks = {}): Promise<void> {
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

  const planLabel = checkout.planLabel || (plan === 'pro' ? 'Pro' : 'Plus')
  const rzp = new window.Razorpay({
    key: checkout.keyId,
    order_id: checkout.orderId,
    amount: checkout.amount,
    currency: checkout.currency,
    name: '10X RPC',
    description: `${planLabel} plan`,
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
