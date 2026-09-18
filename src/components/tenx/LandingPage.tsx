// 10X RPC — Landing page (matches Roxy reference: hero + seamless experience + pricing)
'use client'
import { PrimaryButton, GhostButton } from './ui'
import { useRouter } from './useRouter'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api, type Me } from '@/lib/api-client'

export function LandingPage() {
  const { navigate } = useRouter()
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Check for OAuth error in URL hash (e.g. #/?error=invalid_scope)
    if (typeof window !== 'undefined') {
      const hash = window.location.hash
      const errorMatch = hash.match(/[?&]error=([^&]+)/)
      if (errorMatch) {
        const errMsg = decodeURIComponent(errorMatch[1])
        toast.error(`OAuth error: ${errMsg}`, { duration: 6000 })
        // Clear the error from URL
        window.location.hash = ''
      }
    }
    api.me().then(m => { setMe(m); setLoading(false) }).catch(() => setLoading(false))
  }, [])

  const onStart = () => {
    if (me?.authenticated) navigate({ name: 'dashboard' })
    else navigate({ name: 'oauth-consent' })
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* Nav */}
      <nav className="flex items-center justify-between px-4 sm:px-8 py-4 sm:py-6">
        <div className="flex items-center gap-2">
          <div className="w-9 h-9 rounded-xl purple-gradient flex items-center justify-center font-black text-white">10</div>
          <span className="text-lg sm:text-xl font-bold text-white">10X RPC</span>
        </div>
        <div className="flex items-center gap-2">
          <a href="#seamless" className="hidden sm:block text-sm text-white/70 hover:text-white px-3 py-1.5">Experience</a>
          <a href="#pricing" className="hidden sm:block text-sm text-white/70 hover:text-white px-3 py-1.5">Pricing</a>
          <GhostButton onClick={onStart} className="text-sm">
            {me?.authenticated ? 'Open Dashboard' : 'Sign in'}
          </GhostButton>
        </div>
      </nav>

      {/* Hero */}
      <section className="flex-1 flex flex-col items-center justify-center text-center px-4 sm:px-8 py-16 sm:py-24">
        <h1 className="text-5xl sm:text-7xl font-black tracking-tight text-white">
          10X RPC Pro
        </h1>
        <p className="mt-4 text-lg sm:text-2xl text-white/70 font-medium">
          The ultimate Discord Rich Presence engine
        </p>
        <p className="mt-1 text-lg sm:text-2xl text-purple-400 font-medium">
          Absolute perfection
        </p>

        <div className="mt-12 flex flex-col sm:flex-row gap-3 items-center">
          <button
            onClick={onStart}
            disabled={loading}
            className="bg-white text-black font-bold rounded-xl px-8 py-3.5 text-base shadow-xl hover:opacity-90 active:scale-[0.98] transition-all min-w-[180px]"
          >
            {loading ? 'Loading...' : 'Start 30 Days Free'}
          </button>
          <GhostButton
            onClick={() => { const el = document.getElementById('pricing'); el?.scrollIntoView({ behavior: 'smooth' }) }}
            className="px-8 py-3.5 text-base border-white/20 text-white"
          >
            View Pricing
          </GhostButton>
        </div>
      </section>

      {/* Seamless Experience */}
      <section id="seamless" className="px-4 sm:px-8 py-16 sm:py-24">
        <div className="max-w-2xl mx-auto text-center">
          <h2 className="text-3xl sm:text-5xl font-black text-white mb-3">Seamless Experience</h2>
          <p className="text-lg text-white/60 mb-2">This isn&apos;t your regular Discord RPC</p>
          <p className="text-lg text-purple-400 mb-12">Let me tell you why</p>

          <div className="space-y-4 text-left">
            <FeatureCard
              emoji="🔑"
              title="Absolute Safety"
              desc="Yup NO any tokens, ids or passwords needed"
            />
            <FeatureCard
              emoji="☁️"
              title="Cloud Powered"
              desc="Yup no need to download any apps, code or files"
            />
            <FeatureCard
              emoji="🛡️"
              title="Zero Ban Risk"
              desc="Yup we use the official Discord RPC SDK and endpoints"
            />
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="px-4 sm:px-8 py-16 sm:py-24 bg-black/40">
        <div className="max-w-2xl mx-auto">
          <div className="text-center mb-10">
            <h2 className="text-3xl sm:text-5xl font-black text-white mb-4">Simple Pricing</h2>
            <p className="text-sm sm:text-base text-white/60 max-w-md mx-auto">
              Just covering our cloud server bills. But hey, try the 30 day trial first — only buy if you love it.
            </p>
          </div>

          <div className="space-y-4">
            {/* Trial */}
            <PricingCard
              name="Trial"
              price="$0"
              period="/ 30 Days"
              features={['Full feature access', '30 Days validity']}
              cta="Try Now"
              ctaStyle="ghost"
              onCta={onStart}
            />

            {/* Pro (3 Months) */}
            <PricingCard
              name="Pro (3 Months)"
              price="$4"
              originalPrice="$5"
              period="/ 3 Mo"
              badge="20% OFF"
              features={['Full feature Access', 'Priority Support', 'Game RPC Requests', 'Custom discord role']}
              cta="Buy Now"
              ctaStyle="primary"
              highlighted
              onCta={onStart}
            />

            {/* Plus (1 Month) */}
            <PricingCard
              name="Plus (1 Month)"
              price="$2"
              period="/ 1 Mo"
              features={['Full feature access', 'Standard Support', 'Basic discord role']}
              cta="Buy Now"
              ctaStyle="ghost"
              onCta={onStart}
            />
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="px-4 sm:px-8 py-10 border-t border-white/5">
        <div className="max-w-2xl mx-auto text-center space-y-4">
          <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm text-white/60">
            <a href="#" className="hover:text-white">Terms of Service</a>
            <a href="#" className="hover:text-white">Privacy Policy</a>
            <a href="#" className="hover:text-white">Refund Policy</a>
            <a href="https://discord.gg/jr27qeCZU" target="_blank" rel="noopener noreferrer" className="hover:text-white">Join our Discord</a>
          </div>
          <p className="text-xs text-white/40">Copyright © 2026 10X RPC. All rights reserved.</p>
          <p className="text-xs text-white/30 max-w-md mx-auto">
            10X RPC is not affiliated with, endorsed, or sponsored by Discord Inc.
          </p>
        </div>
      </footer>
    </div>
  )
}

function FeatureCard({ emoji, title, desc }: { emoji: string; title: string; desc: string }) {
  return (
    <div className="glass-card-inner p-5 sm:p-6 hover:border-purple-500/30 transition-colors">
      <div className="text-3xl mb-3">{emoji}</div>
      <h3 className="text-xl sm:text-2xl font-bold text-white mb-2">{title}</h3>
      <p className="text-sm sm:text-base text-white/60">{desc}</p>
    </div>
  )
}

interface PricingCardProps {
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
}

function PricingCard({
  name, price, originalPrice, period, badge, features, cta, ctaStyle, highlighted, onCta
}: PricingCardProps) {
  return (
    <div
      className={`glass-card p-6 relative overflow-hidden ${highlighted ? 'border-purple-500/40 purple-glow' : ''}`}
    >
      {badge && (
        <div className="absolute top-4 right-4 purple-gradient text-white text-xs font-bold px-3 py-1 rounded-full">
          {badge}
        </div>
      )}
      <p className="text-sm text-white/50 mb-1">{name}</p>
      <div className="flex items-baseline gap-2 mb-5">
        {originalPrice && <span className="text-lg text-white/40 line-through">{originalPrice}</span>}
        <span className="text-5xl font-black text-white">{price}</span>
        <span className="text-sm text-white/50">{period}</span>
      </div>
      <ul className="space-y-2 mb-6">
        {features.map(f => (
          <li key={f} className="flex items-center gap-2 text-sm text-white/80">
            <span className="text-green-400">✓</span>
            <span>{f}</span>
          </li>
        ))}
      </ul>
      {ctaStyle === 'primary' ? (
        <button
          onClick={onCta}
          className="w-full bg-white text-black font-bold rounded-xl py-3.5 hover:opacity-90 active:scale-[0.98] transition-all"
        >
          {cta}
        </button>
      ) : (
        <button
          onClick={onCta}
          className="w-full bg-white/5 border border-white/15 text-white font-bold rounded-xl py-3.5 hover:bg-white/10 active:scale-[0.98] transition-all"
        >
          {cta}
        </button>
      )}
    </div>
  )
}
