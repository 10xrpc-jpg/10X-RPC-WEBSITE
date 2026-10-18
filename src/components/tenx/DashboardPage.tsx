// 10X RPC — Main dashboard page (/dashboard)
// v2: layout-matched shimmer skeleton on first load, greeting header with
// live status/plan pills, payment buttons priced from the admin-managed
// plan catalog (GET /api/plans) instead of hardcoded rupees.
'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import { api, type Me, type RpcConfig, type PublicPlans } from '@/lib/api-client'
import { useRouter } from './useRouter'
import { ProfileSection } from './ProfileSection'
import { BrandMark, BrandName } from './BrandMark'
import { SmartSleepTimerCard } from './SmartSleepTimerCard'
import { RpcSlotsManager } from './RpcSlotsManager'
import { ConfigBackupCard } from './ConfigBackupCard'
import { ReconnectBanner } from './ReconnectBanner'
import { startPlanCheckout, consumePendingPlanCheckout } from './subscriptionCheckout'
import { toast } from 'sonner'
import { TriangleAlert, Zap, Check, Ban, Star, ArrowLeft, Hourglass } from 'lucide-react'

export function DashboardPage() {
  const { navigate } = useRouter()
  const [me, setMe] = useState<Me | null>(null)
  const [liveSlots, setLiveSlots] = useState<RpcConfig[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const refreshInFlight = useRef<Promise<void> | null>(null)

  const refresh = useCallback(async () => {
    // In-flight dedupe — StrictMode double-mounts and overlapping callers
    // (toggles, keep-alive) must never fire two concurrent /api/me loads: the
    // second response would overwrite the first (this raced the one-time
    // slotExclusivityFixed heal toast into a blank flag).
    if (refreshInFlight.current) return refreshInFlight.current
    const run = (async () => {
      try {
        const m = await api.me()
        setMe(m)
        setError(null)
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Failed to load'
        if (msg.includes('not_authenticated') || msg.includes('401')) {
          // Don't redirect to OAuth — just show the Welcome gate with Demo option
          setMe({ authenticated: false })
          return
        }
        setMe(prev => {
          if (!prev) {
            setError(msg)
          } else {
            console.warn('Background session refresh skipped temporary error:', msg)
          }
          return prev
        })
      } finally {
        setLoading(false)
      }
    })()
    refreshInFlight.current = run.finally(() => { refreshInFlight.current = null })
    return run
  }, [])

  useEffect(() => {
    refresh()
    // Keep-alive: refresh session every 4 minutes + ping keep-awake endpoint
    const t = setInterval(refresh, 4 * 60 * 1000)
    // Also ping the keep-awake endpoint every 10 minutes to prevent Render sleep
    const awake = setInterval(() => {
      fetch('/api/keep-awake').catch(() => {})
    }, 10 * 60 * 1000)
    return () => { clearInterval(t); clearInterval(awake) }
  }, [refresh])

  // Purchase resume: a visitor who clicked Buy Now on the landing page while
  // logged out completes Discord OAuth → lands here → the saved intent opens
  // the Razorpay checkout automatically. consume() clears the intent before
  // starting, so this can never loop; StrictMode double-mount is safe (the
  // second run finds nothing saved). Waits for the auth check so a logged-out
  // dashboard visit keeps the intent for a future login instead of erroring.
  useEffect(() => {
    if (loading || !me?.authenticated) return
    const pending = consumePendingPlanCheckout({
      onSuccess: ({ planLabel, lifted }) => {
        toast.dismiss('buy')
        toast.success(lifted
          ? `${planLabel} activated — your subscription is live!`
          : `${planLabel} payment received — your time was added to your subscription.`)
        refresh()
      },
      onError: (message) => {
        toast.dismiss('buy')
        toast.error(message)
      },
      onDismiss: () => {
        toast.dismiss('buy')
        toast('Payment cancelled — you were not charged.', { duration: 5000 })
      },
    })
    if (pending) toast.loading('Opening payment…', { id: 'buy' })
  }, [loading, me?.authenticated])

  if (loading) return <DashboardSkeleton />

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="glass-card p-6 max-w-md text-center">
          <p className="text-white font-medium mb-2"><TriangleAlert className="w-4 h-4 inline-block align-[-2px] mr-1 text-purple-300" />Something went wrong</p>
          <p className="text-sm text-white/60 mb-4">{error}</p>
          <button
            onClick={refresh}
            className="purple-gradient text-white font-medium px-4 py-2 rounded-xl"
          >
            Try again
          </button>
        </div>
      </div>
    )
  }

  if (!me?.authenticated) {
    // Not logged in — show demo option
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="glass-card p-8 max-w-md text-center">
          <BrandMark className="w-14 h-14 rounded-2xl mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-white mb-2">Welcome to <BrandName /> RPC</h1>
          <p className="text-sm text-white/60 mb-6">
            Sign in with Discord to access your dashboard, or try the demo mode to preview the UI.
          </p>
          <div className="flex flex-col gap-2">
            <button
              onClick={() => { window.location.href = '/auth/discord' }}
              className="purple-gradient text-white font-semibold rounded-xl px-4 py-3 shadow-lg shadow-purple-900/30 hover:opacity-90 active:scale-[0.98] transition-all"
            >
              Sign in with Discord
            </button>
            <button
              onClick={async () => {
                try {
                  const r = await api.demoLogin()
                  if (r.redirect) {
                    // Redirect to /set-session to set the cookie on Vercel's domain
                    window.location.href = r.redirect
                  } else {
                    refresh()
                  }
                } catch (e) { console.error(e) }
              }}
              className="bg-white/5 border border-white/10 text-white font-medium rounded-xl px-4 py-3 hover:bg-white/10 active:scale-[0.98] transition-all"
            >
              Try Demo Mode
            </button>
            <button
              onClick={() => navigate({ name: 'home' })}
              className="inline-flex items-center gap-1 text-xs text-white/50 hover:text-white mt-2"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back to landing
            </button>
          </div>
        </div>
      </div>
    )
  }

  const rpcLive = !!me.session?.rpcEnabled && me.session?.gatewayReady !== false

  return (
    <div className="min-h-screen px-4 sm:px-6 py-6 max-w-2xl mx-auto pb-12 flex flex-col">
      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-y-2 mb-5">
        <div className="flex items-center gap-2">
          <BrandMark className="w-9 h-9" />
          <BrandName className="text-lg font-bold" suffix=" RPC" />
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {me.isAdmin && (
            <button
              onClick={() => navigate({ name: 'admin' })}
              aria-label="Open admin dashboard"
              className="flex items-center gap-1.5 text-xs text-amber-200 hover:text-amber-100 bg-amber-500/10 border border-amber-500/30 px-3 py-1.5 rounded-lg hover:bg-amber-500/20 transition-all"
            >
              <svg className="text-amber-400" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1 1 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
              </svg>
              Admin
            </button>
          )}
          <a
            href="https://discord.gg/FZvJfZx2V5"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs text-[#c9cdff] hover:text-[#dfe2ff] bg-[#5865F2]/10 border border-[#5865F2]/30 px-3 py-1.5 rounded-lg hover:bg-[#5865F2]/20 transition-all"
          >
            <svg className="text-[#8b93ff]" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.009c.12.099.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.891.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.056c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.331c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.157 2.157-2.157 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
            </svg>
            Discord Server
          </a>
          <button
            onClick={() => navigate({ name: 'home' })}
            className="inline-flex items-center gap-1 text-xs text-white/60 hover:text-white px-3 py-1.5 rounded-lg hover:bg-white/5"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Home
          </button>
        </div>
      </header>

      {/* Greeting + at-a-glance status pills */}
      <GreetingHeader me={me} rpcLive={rpcLive} />

      <div className="space-y-4">
        {/* Discord-link health: without a live token the 24/7 daemon cannot run
            Status / RPC / Game RPC — surface it instead of failing silently. */}
        {me.session?.hasDiscordToken === false && (
          <ReconnectBanner isDemo={me.user?.id === 'demo-user-10x'} />
        )}

        {/* Subscription lifecycle — suspended (hard block + renew CTA) or a
            free trial ending within 24h (soft warning). */}
        <SubscriptionBanner subscription={me.subscription} renewUrl={me.renewUrl} trialDays={me.trialDays} onRefresh={refresh} prefillName={me.user?.username ?? null} />

        {/* Profile section */}
        <ProfileSection
          me={me}
          onRefresh={refresh}
        />

        {/* Smart sleep timer */}
        <SmartSleepTimerCard
          currentEndsAt={me.session?.sleepTimerActive ? me.session?.sleepTimerEndsAt : null}
          onSaved={refresh}
        />

        {/* Multi-RPC slots (max 3 independent RPCs) + Auto Rotate + Game RPC CTA */}
        <RpcSlotsManager
          me={liveSlots ? { ...me, rpcSlots: liveSlots } : me}
          onRefresh={() => {
            setLiveSlots(null)
            refresh()
          }}
          onGameRpcClick={() => navigate({ name: 'games' })}
          onDraftChange={cfg => {
            setLiveSlots(prev => {
              const base = prev ?? (me.rpcSlots ?? (me.rpcConfig ? [me.rpcConfig] : []))
              return base.map(s => (s.id && s.id === cfg.id ? { ...s, ...cfg } : s))
            })
          }}
        />

        {/* Application RPC card is intentionally HIDDEN from the dashboard
            (user request). The Application RPC system itself — backend,
            daemon, API routes and saved config — remains fully intact and
            isolated; re-show by rendering <ApplicationRpcCard /> again. */}
        {/* Backup & Restore — export/import every saved setting as JSON */}
        <ConfigBackupCard me={me} onRefresh={() => {
          setLiveSlots(null)
          refresh()
        }} />

        {/* Footer */}
        <p className="text-xs text-white/30 text-center pt-4">
          <TriangleAlert className="w-3.5 h-3.5 inline-block align-[-3px] mr-1 text-purple-300" />
          10X RPC is not responsible if your account gets banned or blocked. Use at your own risk.
        </p>
      </div>
    </div>
  )
}

/* ---------- Greeting + status pills ---------- */

function GreetingHeader({ me, rpcLive }: { me: Me; rpcLive: boolean }) {
  const hour = new Date().getHours()
  const greeting = hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  const plan = planPill(me)

  return (
    <div className="mb-5">
      <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight">
        {greeting}, <span className="bg-gradient-to-r from-white via-white to-purple-200/80 bg-clip-text text-transparent">{me.user?.username ?? 'there'}</span>
      </h1>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {/* Presence engine state */}
        <span
          className={`inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide px-2.5 py-1 rounded-full border ${
            rpcLive
              ? 'text-white/90 border-purple-500/30 bg-purple-500/10'
              : 'text-white/45 border-white/10 bg-white/5'
          }`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${rpcLive ? 'bg-purple-400 animate-pulse' : 'bg-white/30'}`} />
          {rpcLive ? 'Live' : 'Offline'}
        </span>
        {/* Subscription state */}
        {plan && (
          <span className={`inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide px-2.5 py-1 rounded-full border ${plan.className}`}>
            {plan.label}
          </span>
        )}
        {/* Platform */}
        {me.session?.statusPlatform && me.session.statusPlatform !== 'desktop' && (
          <span className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide px-2.5 py-1 rounded-full border text-white/90 border-purple-500/30 bg-purple-500/10">
            {platformLabel(me.session.statusPlatform)}
          </span>
        )}
        {/* VR active */}
        {me.session?.vrStatusActive && (
          <span className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide px-2.5 py-1 rounded-full border text-white/90 border-purple-500/30 bg-purple-500/10">
            VR Active
          </span>
        )}
      </div>
    </div>
  )
}

function platformLabel(p: string): string {
  const map: Record<string, string> = {
    mobile: 'Mobile Status',
    meta_quest: 'Meta Quest',
    console: 'Console',
    xbox: 'Xbox',
    ps4: 'PS4',
    ps5: 'PS5',
  }
  return map[p] || p
}

function planPill(me: Me): { label: string; className: string } | null {
  const s = me.subscription
  if (!s) return null
  if (s.status === 'suspended') {
    return { label: 'Suspended', className: 'text-white/90 border-purple-500/30 bg-purple-500/10' }
  }
  if (s.neverExpires) {
    return { label: 'Lifetime', className: 'text-white/90 border-purple-500/30 bg-purple-500/10' }
  }
  if (s.status === 'trialing') {
    const msLeft = s.msLeft || 0
    if (msLeft < 24 * 60 * 60 * 1000) {
      const h = Math.max(1, Math.floor(msLeft / (60 * 60 * 1000)))
      return { label: `Trial · ${h}h left`, className: 'text-white/90 border-purple-500/30 bg-purple-500/10' }
    }
    const daysLeft = Math.ceil(msLeft / (24 * 60 * 60 * 1000))
    return { label: `Trial · ${daysLeft}d left`, className: 'text-white/90 border-purple-500/30 bg-purple-500/10' }
  }
  if (s.status === 'active') {
    const name = s.plan && s.plan !== 'free' ? s.plan.charAt(0).toUpperCase() + s.plan.slice(1) : 'Active'
    return { label: name, className: 'text-white/90 border-purple-500/30 bg-purple-500/10' }
  }
  return null
}

/* ---------- Skeleton (layout-matched shimmer) ---------- */

function Sk({ className }: { className?: string }) {
  return <div aria-hidden className={`skeleton-shimmer ${className ?? 'rounded-xl'}`} />
}

function DashboardSkeleton() {
  return (
    <div className="min-h-screen px-4 sm:px-6 py-6 max-w-2xl mx-auto pb-12" role="status" aria-label="Loading dashboard">
      {/* Header */}
      <header className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <Sk className="w-9 h-9 rounded-lg" />
          <Sk className="h-5 w-24" />
        </div>
        <div className="flex items-center gap-2">
          <Sk className="h-7 w-16 rounded-lg" />
          <Sk className="h-7 w-24 rounded-lg" />
          <Sk className="h-7 w-14 rounded-lg" />
        </div>
      </header>

      {/* Greeting + pills */}
      <div className="mb-6">
        <Sk className="h-7 w-56 max-w-full" />
        <div className="mt-3 flex items-center gap-2">
          <Sk className="h-5 w-16 rounded-full" />
          <Sk className="h-5 w-24 rounded-full" />
          <Sk className="h-5 w-20 rounded-full" />
        </div>
      </div>

      {/* Profile card */}
      <div className="bg-[#0e0d14]/60 border border-white/5 rounded-[28px] p-6 mb-4">
        <div className="flex justify-end"><Sk className="w-8 h-8 rounded-full" /></div>
        <div className="flex flex-col items-center mt-2 mb-6 gap-3">
          <Sk className="w-28 h-28 rounded-full" />
          <Sk className="h-6 w-40" />
          <Sk className="h-3.5 w-24" />
        </div>
        <div className="flex items-center justify-between mb-4 px-1">
          <Sk className="h-3.5 w-28" />
          <Sk className="h-6 w-11 rounded-full" />
        </div>
        <div className="flex items-center gap-2">
          <Sk className="flex-1 h-11" />
          <Sk className="flex-1 h-11" />
          <Sk className="flex-1 h-11" />
        </div>
        {/* preview card */}
        <div className="mt-5 bg-white/[0.03] border border-white/5 rounded-2xl p-4">
          <div className="flex items-start gap-3">
            <Sk className="w-11 h-11 rounded-full shrink-0" />
            <div className="flex-1 space-y-2">
              <Sk className="h-4 w-32" />
              <Sk className="h-3 w-48 max-w-full" />
            </div>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <Sk className="w-14 h-14 shrink-0" />
            <div className="flex-1 space-y-2">
              <Sk className="h-4 w-28" />
              <Sk className="h-3 w-40 max-w-full" />
              <Sk className="h-3 w-32 max-w-full" />
            </div>
          </div>
        </div>
      </div>

      {/* Rich presence form card */}
      <div className="glass-card p-5 sm:p-6 mb-4">
        <div className="flex items-center gap-2 mb-4">
          <Sk className="w-6 h-6 rounded-lg" />
          <Sk className="h-5 w-40" />
        </div>
        <div className="space-y-3">
          <Sk className="h-11 w-full" />
          <Sk className="h-11 w-full" />
          <Sk className="h-11 w-full" />
        </div>
        <div className="flex gap-2 mt-4">
          <Sk className="flex-1 h-11" />
          <Sk className="w-28 h-11" />
        </div>
      </div>

      {/* Sleep timer card */}
      <div className="glass-card p-5 sm:p-6">
        <div className="flex items-center gap-2 mb-4">
          <Sk className="w-6 h-6 rounded-lg" />
          <Sk className="h-5 w-36" />
        </div>
        <div className="flex gap-2">
          <Sk className="flex-1 h-11" />
          <Sk className="w-28 h-11" />
        </div>
      </div>

      <p className="sr-only">Loading dashboard…</p>
    </div>
  )
}

/* ---------- Self-serve plan buttons (DB-priced) ---------- */

/** Human duration label matching the landing pricing card. */
function periodLabel(days: number): string {
  return days >= 28 && days % 28 === 0 ? `${Math.round(days / 28)} Mo` : `${days}d`
}

/** Self-serve plan buttons (Razorpay Checkout: UPI / cards / netbanking).
 *  Shared by the suspended + trial-ending banners. Prices/names come from
 *  the admin-managed plan catalog so re-pricing in /admin reflects here
 *  instantly; falls back to the last-known catalog on API failure. */
function PayButtons({ onDone, prefillName }: {
  onDone?: () => void
  prefillName?: string | null
}) {
  const [busy, setBusy] = useState<'plus' | 'pro' | null>(null)
  const [payError, setPayError] = useState<string | null>(null)
  const [labels, setLabels] = useState<Record<'plus' | 'pro', { name: string; price: string; period: string }>>({
    plus: { name: 'Plus', price: '₹49', period: '1 Mo' },
    pro: { name: 'Pro', price: '₹129', period: '3 Mo' },
  })

  useEffect(() => {
    let alive = true
    api.publicPlans().then((res: PublicPlans) => {
      if (!alive) return
      const next = { ...labels }
      for (const p of res.plans) {
        if (p.slug === 'plus' || p.slug === 'pro') {
          next[p.slug] = {
            name: p.name.replace(/\s*\(.*\)\s*$/, '').trim() || p.name,
            price: `₹${(p.amount / 100).toLocaleString('en-IN')}`,
            period: periodLabel(p.durationDays),
          }
        }
      }
      setLabels(next)
    }).catch(() => { /* keep fallback labels */ })
    return () => { alive = false }
  }, [])

  const launch = (plan: 'plus' | 'pro') => {
    if (busy) return
    setPayError(null)
    setBusy(plan)
    startPlanCheckout(plan, {
      prefillName,
      onSuccess: () => {
        setBusy(null)
        onDone?.()
      },
      onError: (message) => {
        setBusy(null)
        setPayError(message)
      },
      onDismiss: () => setBusy(null),
    })
  }

  const primary = 'purple-gradient text-white shadow-lg shadow-purple-900/30 hover:opacity-90'
  const secondary = 'text-white/90 hover:text-white bg-purple-500/15 hover:bg-purple-500/30 border border-purple-500/25'

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => launch('pro')}
          disabled={busy !== null}
          className={`text-xs font-semibold px-4 py-2.5 min-h-[44px] rounded-xl transition-all disabled:opacity-60 active:scale-[0.98] ${primary}`}
        >
          {busy === 'pro' ? 'Opening payment…' : <span className="inline-flex items-center gap-1.5"><Zap className="w-3.5 h-3.5 text-purple-200" />{labels.pro.name} — {labels.pro.price} / {labels.pro.period}</span>}
        </button>
        <button
          type="button"
          onClick={() => launch('plus')}
          disabled={busy !== null}
          className={`text-xs font-semibold px-4 py-2.5 min-h-[44px] rounded-xl transition-all disabled:opacity-60 active:scale-[0.98] ${secondary}`}
        >
          {busy === 'plus' ? 'Opening payment…' : `${labels.plus.name} — ${labels.plus.price} / ${labels.plus.period}`}
        </button>
        <span className="text-[11px] text-white/40">UPI · cards · netbanking</span>
      </div>
      {payError && <p className="text-[11px] text-white/90 mt-2">{payError}</p>}
    </div>
  )
}

/** Subscription lifecycle banner: suspended → hard red block with renew CTA;
 *  free trial < 24h left → amber warning. Active/lifetime → nothing. */
export function SubscriptionBanner({ subscription, renewUrl, trialDays, onRefresh, prefillName }: {
  subscription?: Me['subscription']
  renewUrl?: string
  trialDays?: number
  onRefresh?: () => void
  prefillName?: string | null
}) {
  const [paid, setPaid] = useState<string | null>(null)

  if (!subscription) return null

  const paidNote = paid ? (
    <p className="text-xs font-semibold text-white/90 mt-2" role="status"><Check className="w-3.5 h-3.5 inline-block align-[-3px] mr-0.5 text-purple-300" />{paid} — subscription active, RPC unlocked. Refreshing…</p>
  ) : null

  if (subscription.status === 'suspended') {
    return (
      <div
        role="alert"
        className="rounded-2xl border border-purple-500/40 bg-purple-500/10 p-4 sm:p-5"
      >
        <div className="flex items-start gap-3">
          <Ban className="w-6 h-6 shrink-0 text-purple-300" aria-hidden />
          <div className="flex-1 min-w-0">
            <p className="font-bold text-white/90">Subscription suspended</p>
            <p className="text-sm text-white/50 mt-1 leading-relaxed">
              Your plan has ended or was suspended — 24/7 RPC, status and Game RPC are paused.
              Pay to restore your presence instantly (your saved configs are untouched).
            </p>
            {paidNote}
            <PayButtons
              prefillName={prefillName}
              onDone={() => {
                setPaid('Payment successful')
                setTimeout(() => onRefresh?.(), 900)
              }}
            />
            <div className="flex flex-wrap items-center gap-2 mt-2">
              <a
                href={renewUrl || 'https://discord.gg/FZvJfZx2V5'}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] font-semibold text-white/60 hover:text-white underline underline-offset-2 transition-all"
              >
                <Star className="w-3 h-3 inline-block align-[-2px] mr-1 text-purple-300" />Renew on Discord instead
              </a>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (subscription.status === 'trialing' && !subscription.neverExpires) {
    const msLeft = subscription.msLeft || 0
    if (msLeft >= 24 * 60 * 60 * 1000) return null
    const hoursLeft = Math.max(1, Math.floor(msLeft / (60 * 60 * 1000)))
    return (
      <div
        role="status"
        className="rounded-2xl border border-purple-500/40 bg-purple-500/10 p-4"
      >
        <div className="flex items-start gap-3">
          <Hourglass className="w-5 h-5 shrink-0 text-purple-300 mt-0.5" aria-hidden />
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-white/90 text-sm">
              Free trial ends in {hoursLeft} hour{hoursLeft === 1 ? '' : 's'}
            </p>
            <p className="text-xs text-white/50 mt-0.5">
              After that your subscription is suspended and 24/7 RPC stops. Grab a plan to keep it running.
            </p>
            {paidNote}
            <PayButtons
              prefillName={prefillName}
              onDone={() => {
                setPaid('Payment successful')
                setTimeout(() => onRefresh?.(), 900)
              }}
            />
          </div>
        </div>
      </div>
    )
  }

  // Active paid plan or lifetime — nothing to warn about.
  void trialDays
  void renewUrl
  return null
}
