// 10X RPC — DynamicPricing: the landing pricing section rendered from the
// admin-managed Plan catalog (GET /api/plans). While loading (or if the API
// is unreachable) it shows the static fallback cards (children) so the page
// never flashes or breaks. Once plans arrive, every price/duration/badge/
// feature comes from the database — the admin Plans tab re-prices this page
// with zero deploys.
'use client'
import { useEffect, useState, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import { api, type PublicPlans } from '@/lib/api-client'

function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN')}`
}

export function DynamicPricing({ onStart, onBuyPlan, children }: {
  onStart: () => void
  /** Called with the plan slug when a paid plan's Buy Now is clicked —
   *  opens the Razorpay checkout for that plan (falls back to onStart
   *  when omitted so standalone usages keep working). */
  onBuyPlan?: (slug: string) => void
  children: ReactNode
}) {
  const [data, setData] = useState<PublicPlans | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    let alive = true
    api
      .publicPlans()
      .then(res => {
        if (!alive) return
        if (res.plans.length > 0) setData(res)
        setDone(true)
      })
      .catch(() => {
        if (alive) setDone(true) // keep the static fallback forever
      })
    return () => {
      alive = false
    }
  }, [])

  // Loading or failed → the original static pricing (no layout shift).
  if (!data) return <>{children}</>

  const trial = data.trial
  const plans = data.plans
  // Index of the most expensive visible plan — it always gets the primary CTA.
  const topPlanIdx = plans.reduce((best, p, i) => (p.amount > (plans[best]?.amount ?? -1) ? i : best), 0)

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 md:items-stretch">
      {/* Trial card — from the DB trial policy (hidden when trials are off) */}
      {trial && trial.enabled && trial.days > 0 && (
        <PricingCard
          name={trial.name}
          price="₹0"
          period={`/ ${trial.days} Day${trial.days === 1 ? '' : 's'}`}
          features={trial.features.length > 0 ? trial.features : ['Full feature access', 'No card needed']}
          cta="Try Now"
          ctaStyle="ghost"
          onCta={onStart}
        />
      )}

      {/* Paid plans — from the admin-managed catalog, displayOrder asc.
          The most expensive plan gets the purple primary CTA (and a
          "Most popular" highlight when it has no admin-set badge). */}
      {plans.map((p, idx) => {
        const topPlan = topPlanIdx === idx
        return (
          <PricingCard
            key={p.slug}
            name={p.name}
            price={rupees(p.amount)}
            originalPrice={p.originalAmount ? rupees(p.originalAmount) : undefined}
            period={`/ ${p.durationDays >= 28 && p.durationDays % 28 === 0 ? `${Math.round(p.durationDays / 28)} Mo` : `${p.durationDays}d`}`}
            badge={p.badge ?? (topPlan ? 'Most popular' : undefined)}
            features={p.features}
            cta="Buy Now"
            ctaStyle={topPlan ? 'primary' : 'ghost'}
            highlighted={topPlan || !!p.badge}
            onCta={() => (onBuyPlan ? onBuyPlan(p.slug) : onStart())}
          />
        )
      })}

      {/* Trials disabled and no visible plans → nudge to Discord */}
      {(!trial || !trial.enabled || trial.days <= 0) && plans.length === 0 && (
        <p className="text-center text-sm text-white/50 py-6">
          Plans are being updated — renew on Discord in the meantime.
        </p>
      )}
    </div>
  )
}

export function PricingCard({ name, price, originalPrice, period, badge, features, cta, ctaStyle, highlighted, onCta }: {
  name: string
  price: string
  originalPrice?: string
  period: string
  badge?: string
  features: string[]
  cta: string
  ctaStyle: 'primary' | 'ghost'
  highlighted?: boolean
  onCta: () => void
}) {
  return (
    <div className={`glass-card-inner p-6 relative h-full flex flex-col premium-hover ${highlighted ? 'border-purple-500/40 shadow-[0_0_28px_rgba(168,85,247,0.16)]' : 'hover:border-white/12'}`}>
      {badge && (
        <span className="absolute -top-2.5 right-4 text-[10px] font-bold uppercase tracking-wide px-2.5 py-1 rounded-full bg-gradient-to-r from-purple-500 to-purple-700 text-white shadow-lg animate-glow-pulse">
          {badge}
        </span>
      )}
      <h3 className="font-bold text-white text-lg">{name}</h3>
      <div className="flex items-baseline gap-2 mt-2 mb-4">
        {originalPrice && <span className="text-white/30 line-through text-lg">{originalPrice}</span>}
        <span className="text-4xl font-black text-white">{price}</span>
        <span className="text-sm text-white/45">{period}</span>
      </div>
      <ul className="space-y-2.5 mb-6">
        {features.map(f => (
          <li key={f} className="flex items-start gap-2.5 text-sm text-white/70">
            <Check className="w-4 h-4 text-purple-300 mt-0.5 shrink-0" strokeWidth={3} />
            <span>{f}</span>
          </li>
        ))}
      </ul>
      {ctaStyle === 'primary' ? (
        <button
          onClick={onCta}
          className="mt-auto w-full purple-gradient text-white font-bold rounded-xl py-3 hover:opacity-90 active:scale-[0.98] transition-all shadow-lg shadow-purple-900/30 btn-shine"
        >
          {cta}
        </button>
      ) : (
        <button
          onClick={onCta}
          className="mt-auto w-full bg-white/5 border border-white/15 text-white font-semibold rounded-xl py-3 hover:bg-white/10 active:scale-[0.98] transition-all"
        >
          {cta}
        </button>
      )}
    </div>
  )
}
