// 10X RPC — Landing page v2
// Hero (with live Discord-style product mockup + floating feature chips) →
// game-chip marquee → feature grid → safety strip → how-it-works + stats →
// DB-driven pricing → FAQ → final CTA → footer. Static fallback pricing
// mirrors the current DB catalog so an API outage never misleads.
'use client'
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Sparkles, Gamepad2, Glasses, MoonStar, Globe2, RefreshCcw,
  ShieldCheck, Lock, Cloud, Zap, ChevronRight, Menu, X,
  LogIn, CreditCard, Radio, Check,
} from 'lucide-react'
import { GhostButton } from './ui'
import { BrandMark } from './BrandMark'
import { useRouter } from './useRouter'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { api, type Me } from '@/lib/api-client'
import { DynamicPricing, PricingCard } from './DynamicPricing'

const GAMES = [
  'Valorant', 'GTA V', 'Minecraft', 'Counter-Strike 2', 'Genshin Impact',
  'VRChat', 'Wuthering Waves', 'Forza Horizon 5', 'Arknights', 'Arknights: Endfield',
]

const NAV_LINKS = [
  { label: 'Features', href: '#features' },
  { label: 'How it works', href: '#how' },
  { label: 'Pricing', href: '#pricing' },
  { label: 'FAQ', href: '#faq' },
]

export function LandingPage() {
  const { navigate } = useRouter()
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)
  const [scrolled, setScrolled] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    // Check for OAuth error in the URL query (?error=invalid_scope) or a
    // legacy hash form (#/?error=...) from old bookmarks
    if (typeof window !== 'undefined') {
      const { search, hash } = window.location
      const errorMatch = (search + hash).match(/[?&]error=([^&]+)/)
      if (errorMatch) {
        const errMsg = decodeURIComponent(errorMatch[1])
        window.history.replaceState(null, '', window.location.pathname)
        // Defer the toast one tick — toasts fired during the first commit
        // pass race the sonner portal mount and never render
        setTimeout(() => toast.error(`OAuth error: ${errMsg}`, { duration: 6000 }), 60)
      }
    }
    api.me().then(m => { setMe(m); setLoading(false) }).catch(() => setLoading(false))
  }, [])

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const onStart = () => {
    if (me?.authenticated) navigate({ name: 'dashboard' })
    else window.location.href = '/auth/discord'
  }

  const scrollTo = (id: string) => {
    setMenuOpen(false)
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })
  }

  const trialDays = me?.trialDays ?? 3
  const startLabel = loading ? 'Loading...' : `Start ${trialDays} Days Free`

  return (
    <div className="min-h-screen flex flex-col">
      {/* ============ NAV ============ */}
      <nav
        className={cn(
          'sticky top-0 z-50 transition-all duration-300',
          scrolled
            ? 'bg-[#0a0b0f]/85 backdrop-blur-xl border-b border-white/8 shadow-lg shadow-black/20'
            : 'bg-transparent border-b border-transparent'
        )}
      >
        <div className="max-w-6xl mx-auto flex items-center justify-between px-4 sm:px-6 py-3.5">
          <button onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} className="flex items-center gap-2" aria-label="10X RPC — back to top">
            <BrandMark className="w-9 h-9" />
            <span className="text-lg sm:text-xl font-bold text-white">10X RPC</span>
          </button>

          <div className="hidden lg:flex items-center gap-1">
            {NAV_LINKS.map(l => (
              <a key={l.href} href={l.href} className="text-sm text-white/70 hover:text-white px-3 py-2 rounded-lg hover:bg-white/5 transition-colors">
                {l.label}
              </a>
            ))}
            <a href="/uptime" className="text-sm text-white/70 hover:text-white px-3 py-2 rounded-lg hover:bg-white/5 transition-colors">Uptime</a>
          </div>

          <div className="hidden lg:block">
            <button
              onClick={onStart}
              disabled={loading}
              className="purple-gradient text-white text-sm font-semibold rounded-xl px-5 py-2.5 shadow-lg shadow-purple-900/30 hover:opacity-90 active:scale-[0.98] transition-all"
            >
              {me?.authenticated ? 'Open Dashboard' : 'Start Free'}
            </button>
          </div>

          <button
            className="lg:hidden text-white/80 hover:text-white p-2 -mr-2"
            onClick={() => setMenuOpen(o => !o)}
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
          >
            {menuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </div>

        {/* Mobile menu */}
        {menuOpen && (
          <div className="lg:hidden border-t border-white/8 bg-[#0a0b0f]/95 backdrop-blur-xl">
            <div className="px-4 py-3 flex flex-col gap-1">
              {NAV_LINKS.map(l => (
                <a key={l.href} href={l.href} onClick={() => setMenuOpen(false)} className="text-sm text-white/80 hover:text-white px-3 py-2.5 rounded-lg hover:bg-white/5 transition-colors">
                  {l.label}
                </a>
              ))}
              <a href="/uptime" onClick={() => setMenuOpen(false)} className="text-sm text-white/80 hover:text-white px-3 py-2.5 rounded-lg hover:bg-white/5 transition-colors">Uptime</a>
              <button
                onClick={() => { setMenuOpen(false); onStart() }}
                className="purple-gradient mt-2 text-white text-sm font-semibold rounded-xl px-5 py-3 hover:opacity-90 active:scale-[0.98] transition-all"
              >
                {me?.authenticated ? 'Open Dashboard' : 'Start Free'}
              </button>
            </div>
          </div>
        )}
      </nav>

      <main className="flex-1 flex flex-col">
        {/* ============ HERO ============ */}
        <section className="relative overflow-hidden">
          <div className="absolute inset-0 hero-grid pointer-events-none" aria-hidden />
          <div className="absolute -top-40 left-1/4 w-[520px] h-[520px] bg-purple-600/20 rounded-full blur-[130px] animate-aurora pointer-events-none" aria-hidden />
          <div className="absolute top-24 -right-40 w-[440px] h-[440px] bg-fuchsia-600/12 rounded-full blur-[120px] animate-aurora-slow pointer-events-none" aria-hidden />

          <div className="relative max-w-6xl mx-auto px-4 sm:px-6 pt-14 sm:pt-20 pb-10 sm:pb-14 grid lg:grid-cols-[1.05fr_0.95fr] gap-12 lg:gap-10 items-center">
            {/* Copy */}
            <div className="text-center lg:text-left">
              <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
                <a
                  href="#features"
                  className="inline-flex items-center gap-1.5 rounded-full border border-purple-500/30 bg-purple-500/10 px-4 py-1.5 text-xs sm:text-sm text-purple-300 hover:bg-purple-500/20 hover:border-purple-500/50 transition-colors"
                >
                  <Zap className="w-3.5 h-3.5" />
                  <span>New: Gamer RPC with ready-made presets</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </a>
              </motion.div>

              <motion.h1
                initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, delay: 0.08 }}
                className="mt-6 text-4xl sm:text-6xl xl:text-7xl font-black tracking-tight text-white leading-[1.05]"
              >
                Your Discord presence,
                <br />
                <span className="bg-gradient-to-r from-purple-400 via-fuchsia-400 to-purple-400 bg-clip-text text-transparent">
                  10X better.
                </span>
              </motion.h1>

              <motion.p
                initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, delay: 0.16 }}
                className="mt-5 text-base sm:text-lg text-white/65 max-w-xl mx-auto lg:mx-0 leading-relaxed"
              >
                The ultimate cloud-powered Rich Presence engine. Custom status, game
                RPC, VR presence and dynamic placeholders — running 24/7, with
                nothing to download and no token required.
              </motion.p>

              <motion.div
                initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, delay: 0.24 }}
                className="mt-8 flex flex-col sm:flex-row gap-3 items-center justify-center lg:justify-start"
              >
                <button
                  onClick={onStart}
                  disabled={loading}
                  className="purple-gradient text-white font-bold rounded-xl px-8 py-3.5 text-base shadow-xl shadow-purple-900/40 hover:opacity-90 active:scale-[0.98] transition-all min-w-[200px]"
                >
                  {startLabel}
                </button>
                <GhostButton
                  onClick={() => scrollTo('pricing')}
                  className="px-8 py-3.5 text-base border-white/20 text-white"
                >
                  View Pricing
                </GhostButton>
              </motion.div>

              <motion.div
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.6, delay: 0.4 }}
                className="mt-8 flex flex-wrap items-center justify-center lg:justify-start gap-x-5 gap-y-2 text-xs text-white/50"
              >
                <span className="inline-flex items-center gap-1.5"><Lock className="w-3.5 h-3.5 text-purple-400" /> No tokens needed</span>
                <span className="inline-flex items-center gap-1.5"><Cloud className="w-3.5 h-3.5 text-purple-400" /> 100% cloud</span>
                <span className="inline-flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5 text-purple-400" /> Official API only</span>
              </motion.div>
            </div>

            {/* Product mockup */}
            <motion.div
              initial={{ opacity: 0, y: 28 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, delay: 0.2 }}
              className="relative mx-auto w-full max-w-md mt-8 mb-8"
            >
              <HeroMockup />

              <motion.div
                className="absolute -top-11 -right-2 sm:-right-6 z-10"
                animate={{ y: [0, -8, 0] }}
                transition={{ duration: 4.5, repeat: Infinity, ease: 'easeInOut' }}
              >
                <FloatChip icon={<Glasses className="w-4 h-4 text-purple-300" />} title="VR Status" sub="Meta Quest · live" />
              </motion.div>
              <motion.div
                className="absolute -bottom-11 -left-2 sm:-left-4 z-10"
                animate={{ y: [0, 9, 0] }}
                transition={{ duration: 5.5, repeat: Infinity, ease: 'easeInOut', delay: 0.8 }}
              >
                <FloatChip icon={<MoonStar className="w-4 h-4 text-purple-300" />} title="Sleep Timer" sub="Auto-offline · 02:15" />
              </motion.div>
            </motion.div>
          </div>

          {/* Games marquee */}
          <div className="relative pb-12 sm:pb-16">
            <p className="text-center text-[11px] uppercase tracking-[0.2em] text-white/35 mb-4">Ready-made presets for</p>
            <div className="marquee-mask marquee-paused overflow-hidden">
              <div className="animate-marquee flex w-max items-center gap-3">
                {[...GAMES, ...GAMES].map((g, i) => (
                  <span
                    key={`${g}-${i}`}
                    className="whitespace-nowrap text-xs text-white/55 border border-white/8 bg-white/[0.03] rounded-full px-4 py-1.5"
                  >
                    {g}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ============ FEATURES ============ */}
        <section id="features" className="relative px-4 sm:px-6 py-20 sm:py-28 scroll-mt-20">
          <span id="seamless" aria-hidden className="absolute" /> {/* legacy bookmark anchor */}
          <div className="max-w-6xl mx-auto">
            <SectionHeading
              eyebrow="Features"
              title="Everything your status wishes it could do"
              sub="One dashboard for every kind of presence Discord supports — all running from our cloud, around the clock."
            />
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {FEATURES.map((f, i) => (
                <FeatureCard key={f.title} {...f} delay={i * 0.06} />
              ))}
            </div>

            {/* Safety strip */}
            <div className="mt-4 grid sm:grid-cols-3 gap-4">
              {SAFETY.map((s, i) => (
                <Reveal key={s.title} delay={i * 0.06}>
                  <div className="glass-card p-5 flex items-start gap-3.5 h-full">
                    <div className="shrink-0 w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                      <s.icon className="w-5 h-5 text-emerald-400" />
                    </div>
                    <div>
                      <h3 className="font-bold text-white text-sm sm:text-base">{s.title}</h3>
                      <p className="text-xs sm:text-sm text-white/55 mt-1 leading-relaxed">{s.desc}</p>
                    </div>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ============ HOW IT WORKS + STATS ============ */}
        <section id="how" className="px-4 sm:px-6 py-20 sm:py-28 scroll-mt-20 bg-black/30 border-y border-white/5">
          <div className="max-w-6xl mx-auto">
            <SectionHeading
              eyebrow="How it works"
              title="Live in under 2 minutes"
              sub="No downloads, no code, no Discord token — just three steps."
            />
            <div className="grid md:grid-cols-3 gap-4">
              {STEPS.map((s, i) => (
                <Reveal key={s.title} delay={i * 0.08}>
                  <div className="glass-card-inner p-6 relative h-full">
                    <div className="absolute -top-3 left-6 w-7 h-7 rounded-full purple-gradient text-xs font-black text-white flex items-center justify-center shadow-lg shadow-purple-900/40">
                      {i + 1}
                    </div>
                    <div className="w-11 h-11 rounded-xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center mb-4 mt-1">
                      <s.icon className="w-5 h-5 text-purple-300" />
                    </div>
                    <h3 className="font-bold text-white text-lg">{s.title}</h3>
                    <p className="text-sm text-white/55 mt-1.5 leading-relaxed">{s.desc}</p>
                  </div>
                </Reveal>
              ))}
            </div>

            <Reveal delay={0.15}>
              <div className="mt-12 grid grid-cols-2 md:grid-cols-4 gap-4">
                {STATS.map(s => (
                  <div key={s.label} className="glass-card-inner px-4 py-6 text-center">
                    <div className="text-3xl sm:text-4xl font-black bg-gradient-to-r from-purple-400 to-fuchsia-400 bg-clip-text text-transparent">{s.value}</div>
                    <div className="text-xs text-white/50 mt-1.5">{s.label}</div>
                  </div>
                ))}
              </div>
            </Reveal>
          </div>
        </section>

        {/* ============ PRICING ============ */}
        <section id="pricing" className="px-4 sm:px-6 py-20 sm:py-28 scroll-mt-20">
          <div className="max-w-5xl mx-auto">
            <SectionHeading
              eyebrow="Pricing"
              title="Simple, honest pricing"
              sub="Every account starts with a free trial — no card needed. Pay with UPI, cards or netbanking via Razorpay."
            />
            <DynamicPricing onStart={onStart}>
              {/* Static fallback — mirrors the current DB catalog, shown only
                  while /api/plans is loading or unreachable */}
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 md:items-stretch">
                <PricingCard
                  name="Free Trial"
                  price="₹0"
                  period="/ 3 Days"
                  features={['Full feature access', '3 days validity', 'No card needed']}
                  cta="Try Now"
                  ctaStyle="ghost"
                  onCta={onStart}
                />
                <PricingCard
                  name="Pro (3 Months)"
                  price="₹129"
                  originalPrice="₹499"
                  period="/ 3 Mo"
                  badge="20% OFF"
                  features={['Full feature Access', 'Priority Support', 'Game RPC Requests', 'Custom discord role']}
                  cta="Buy Now"
                  ctaStyle="primary"
                  highlighted
                  onCta={onStart}
                />
                <PricingCard
                  name="Plus (1 Month)"
                  price="₹49"
                  originalPrice="₹249"
                  period="/ 1 Mo"
                  features={['Full feature access', 'Standard Support', 'Basic discord role']}
                  cta="Buy Now"
                  ctaStyle="ghost"
                  onCta={onStart}
                />
              </div>
            </DynamicPricing>
            <p className="text-center text-xs text-white/40 mt-8">
              Prices are managed live by the 10X RPC team — what you see here is always current.
            </p>
          </div>
        </section>

        {/* ============ FAQ ============ */}
        <section id="faq" className="px-4 sm:px-6 py-20 sm:py-28 scroll-mt-20 bg-black/30 border-y border-white/5">
          <div className="max-w-2xl mx-auto">
            <SectionHeading eyebrow="FAQ" title="Questions, answered" />
            <div className="space-y-3">
              {FAQS.map((f, i) => (
                <Faq key={f.q} {...f} delay={i * 0.05} />
              ))}
            </div>
          </div>
        </section>

        {/* ============ FINAL CTA ============ */}
        <section className="px-4 sm:px-6 py-20 sm:py-28">
          <Reveal>
            <div className="max-w-4xl mx-auto relative overflow-hidden rounded-[2rem] glass-card border-purple-500/20 purple-glow px-6 py-14 sm:py-16 text-center">
              <div className="absolute -top-24 left-1/3 w-80 h-80 bg-purple-600/25 rounded-full blur-[100px] pointer-events-none" aria-hidden />
              <div className="absolute -bottom-28 right-1/4 w-72 h-72 bg-fuchsia-600/15 rounded-full blur-[100px] pointer-events-none" aria-hidden />
              <div className="relative">
                <h2 className="text-3xl sm:text-5xl font-black text-white tracking-tight">
                  Ready to <span className="bg-gradient-to-r from-purple-400 to-fuchsia-400 bg-clip-text text-transparent">10X</span> your presence?
                </h2>
                <p className="mt-4 text-white/60 text-base sm:text-lg max-w-md mx-auto">
                  Set up your first custom Rich Presence in minutes. Free trial, no card needed.
                </p>
                <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center items-center">
                  <button
                    onClick={onStart}
                    disabled={loading}
                    className="purple-gradient text-white font-bold rounded-xl px-8 py-3.5 text-base shadow-xl shadow-purple-900/40 hover:opacity-90 active:scale-[0.98] transition-all min-w-[200px]"
                  >
                    {me?.authenticated ? 'Open Dashboard' : startLabel}
                  </button>
                  <GhostButton onClick={() => scrollTo('pricing')} className="px-8 py-3.5 text-base border-white/20 text-white">
                    Compare Plans
                  </GhostButton>
                </div>
                <p className="mt-5 text-xs text-white/40 flex items-center justify-center gap-1.5 flex-wrap">
                  <Check className="w-3.5 h-3.5 text-emerald-400" /> No card needed
                  <span className="text-white/20">·</span> Cancel anytime
                </p>
              </div>
            </div>
          </Reveal>
        </section>
      </main>

      {/* ============ FOOTER ============ */}
      <footer className="mt-auto border-t border-white/5 bg-black/40">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-12">
          <div className="grid gap-10 md:grid-cols-[1.5fr_1fr_1fr]">
            <div>
              <div className="flex items-center gap-2">
                <BrandMark className="w-8 h-8" />
                <span className="text-lg font-bold text-white">10X RPC</span>
              </div>
              <p className="mt-3 text-sm text-white/50 max-w-xs leading-relaxed">
                The ultimate Discord Rich Presence engine — cloud powered, ban-safe, always on.
              </p>
              <a
                href="https://discord.gg/FZvJfZx2V5"
                target="_blank"
                rel="noopener noreferrer"
                className="mt-5 inline-flex items-center gap-2 bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-sm font-semibold text-white hover:bg-white/10 transition-colors"
              >
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4" aria-hidden>
                  <path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.058a.082.082 0 0 0 .031.056 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03ZM8.02 15.331c-1.182 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418Zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418Z" />
                </svg>
                Join our Discord
              </a>
            </div>

            <div>
              <h3 className="text-xs font-bold uppercase tracking-wider text-white/40 mb-4">Product</h3>
              <ul className="space-y-2.5 text-sm">
                <li><a href="#features" className="text-white/60 hover:text-white transition-colors">Features</a></li>
                <li><a href="#how" className="text-white/60 hover:text-white transition-colors">How it works</a></li>
                <li><a href="#pricing" className="text-white/60 hover:text-white transition-colors">Pricing</a></li>
                <li><a href="/uptime" className="text-white/60 hover:text-white transition-colors">Uptime</a></li>
                <li><a href="/games" className="text-white/60 hover:text-white transition-colors">Games</a></li>
              </ul>
            </div>

            <div>
              <h3 className="text-xs font-bold uppercase tracking-wider text-white/40 mb-4">Legal &amp; Support</h3>
              <ul className="space-y-2.5 text-sm">
                <li><a href="#" className="text-white/60 hover:text-white transition-colors">Terms of Service</a></li>
                <li><a href="#" className="text-white/60 hover:text-white transition-colors">Privacy Policy</a></li>
                <li><a href="#" className="text-white/60 hover:text-white transition-colors">Refund Policy</a></li>
                <li><a href="https://discord.gg/FZvJfZx2V5" target="_blank" rel="noopener noreferrer" className="text-white/60 hover:text-white transition-colors">Support on Discord</a></li>
              </ul>
            </div>
          </div>

          <div className="mt-10 pt-6 border-t border-white/5 flex flex-col sm:flex-row items-center justify-between gap-3">
            <p className="text-xs text-white/40">Copyright © 2026 10X RPC. All rights reserved.</p>
            <p className="text-xs text-white/30">10X RPC is not affiliated with, endorsed, or sponsored by Discord Inc.</p>
          </div>
        </div>
      </footer>
    </div>
  )
}

/* ---------- motion helpers ---------- */

function Reveal({ children, delay = 0, className }: { children: React.ReactNode; delay?: number; className?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 22 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.55, delay, ease: 'easeOut' }}
      className={className}
    >
      {children}
    </motion.div>
  )
}

/* ---------- section heading ---------- */

function SectionHeading({ eyebrow, title, sub }: { eyebrow: string; title: string; sub?: string }) {
  return (
    <Reveal className="text-center max-w-2xl mx-auto mb-12 sm:mb-14">
      <p className="text-xs font-bold uppercase tracking-[0.25em] text-purple-400">{eyebrow}</p>
      <h2 className="mt-3 text-3xl sm:text-5xl font-black text-white tracking-tight">{title}</h2>
      {sub && <p className="mt-4 text-base text-white/60 leading-relaxed">{sub}</p>}
    </Reveal>
  )
}

/* ---------- hero mockup (static, self-contained) ---------- */

function HeroMockup() {
  const [now, setNow] = useState(Date.now())
  const start = useState(() => Date.now() - 47 * 60 * 1000)[0] // session started 47 min ago
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const elapsed = formatElapsed(Math.max(0, now - start))

  return (
    <div className="relative overflow-hidden bg-gradient-to-b from-[#13111d]/95 via-[#0e0d14]/95 to-[#0a0a0f] border border-white/10 rounded-[28px] p-5 sm:p-6 shadow-2xl shadow-purple-950/30">
      <div className="absolute -top-16 -left-12 w-56 h-56 bg-purple-600/15 rounded-full blur-3xl pointer-events-none" aria-hidden />

      <div className="relative z-10">
        <div className="flex items-center justify-between mb-4">
          <span className="text-xs font-bold tracking-widest text-purple-400 uppercase">Live Preview</span>
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-400">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            LIVE
          </span>
        </div>

        <div className="bg-[#1a1b22]/90 border border-white/10 rounded-2xl p-4 space-y-3.5 shadow-inner">
          {/* user row */}
          <div className="flex items-start gap-3">
            <div className="relative shrink-0">
              <div className="w-11 h-11 rounded-full bg-gradient-to-br from-purple-500 to-fuchsia-500 flex items-center justify-center text-sm font-bold text-white ring-1 ring-white/10">
                A
              </div>
              <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-emerald-500 border-2 border-[#1a1b22]" title="Online" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-bold text-white">Aarav</span>
                <span className="text-[11px] bg-[#2a2b36] border border-white/10 text-white/90 px-2.5 py-0.5 rounded-full inline-flex items-center gap-1.5 font-medium">
                  🎮 Desktop
                </span>
              </div>
              <div className="text-xs text-white/60 flex items-center gap-1.5 mt-0.5">
                <span className="text-purple-400 font-bold">PLAYING</span>
                <span className="truncate text-white/90 font-medium">Valorant</span>
                <span className="text-white/40 whitespace-nowrap">• {elapsed} elapsed</span>
              </div>
            </div>
          </div>

          {/* activity card */}
          <div className="bg-[#121319] border border-white/5 rounded-xl p-3 flex items-center gap-3.5">
            <div className="relative shrink-0">
              <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-rose-500/80 to-purple-600/80 border border-white/10 flex items-center justify-center text-2xl select-none">
                🎯
              </div>
              <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full border-2 border-[#121319] bg-[#1c1d25] flex items-center justify-center text-[10px]">
                ⭐
              </div>
            </div>
            <div className="flex-1 min-w-0 space-y-0.5">
              <div className="text-sm font-bold text-white">VALORANT</div>
              <div className="text-xs text-white/80 font-medium truncate">Ranked Grind — Immortal 2</div>
              <div className="text-xs text-white/60 truncate">Ascent · Brimstone</div>
              <div className="text-xs text-white/50 flex items-center gap-1 pt-0.5">
                <span>👥</span> <span>4 of 5</span>
              </div>
            </div>
          </div>

          {/* presence buttons */}
          <div className="grid grid-cols-2 gap-2 pt-1">
            <span className="text-xs font-semibold text-purple-200 bg-[#20212b] border border-white/10 rounded-xl py-2 px-3 truncate text-center shadow-sm">
              Join my lobby
            </span>
            <span className="text-xs font-semibold text-purple-200 bg-[#20212b] border border-white/10 rounded-xl py-2 px-3 truncate text-center shadow-sm">
              Watch Party
            </span>
          </div>
        </div>

        {/* dynamic placeholders row */}
        <div className="mt-3.5 bg-[#121319]/60 border border-white/5 rounded-xl px-3.5 py-2.5 flex items-center gap-2.5">
          <Globe2 className="w-4 h-4 text-purple-400 shrink-0" />
          <span className="text-[11px] text-white/50">Dynamic placeholders:</span>
          <span className="text-[11px] text-white/80 font-medium truncate">Bengaluru · 27°C · 9:41 PM</span>
        </div>
      </div>
    </div>
  )
}

function FloatChip({ icon, title, sub }: { icon: React.ReactNode; title: string; sub: string }) {
  return (
    <div className="bg-[#12131a]/85 backdrop-blur-xl border border-white/8 rounded-2xl px-3.5 py-2.5 flex items-center gap-2.5 shadow-xl shadow-black/40">
      <div className="w-9 h-9 rounded-xl bg-purple-500/15 border border-purple-500/25 flex items-center justify-center shrink-0">
        {icon}
      </div>
      <div className="leading-tight">
        <div className="text-xs font-bold text-white whitespace-nowrap">{title}</div>
        <div className="text-[10px] text-white/50 whitespace-nowrap">{sub}</div>
      </div>
    </div>
  )
}

/* ---------- data ---------- */

const FEATURES = [
  {
    icon: Sparkles,
    title: 'Custom Rich Presence',
    desc: 'Details, state, images, buttons, party size and timers — every field Discord supports, exactly how you want it.',
  },
  {
    icon: Gamepad2,
    title: 'Gamer RPC',
    desc: 'One-click presets for Valorant, GTA V, Minecraft, CS2 and more — with real game imagery and elapsed timers.',
  },
  {
    icon: Glasses,
    title: 'VR Status',
    desc: 'Show off Meta Quest sessions with a dedicated VR badge your friends can\u2019t miss.',
  },
  {
    icon: RefreshCcw,
    title: 'Status Rotator',
    desc: 'Auto-cycle multiple presence presets on a timer, so your status never goes stale.',
  },
  {
    icon: Globe2,
    title: 'Dynamic Placeholders',
    desc: 'Live weather, clock and city pulled straight into your status and refreshed automatically.',
  },
  {
    icon: MoonStar,
    title: 'Smart Sleep Timer',
    desc: 'Fall asleep gaming? Auto switch to DND or go offline at a time you choose.',
  },
]

const SAFETY = [
  {
    icon: Lock,
    title: 'No tokens. Ever.',
    desc: 'We never touch your Discord token or password — sign in with Discord OAuth only.',
  },
  {
    icon: Cloud,
    title: 'Zero downloads',
    desc: 'Everything runs in our cloud 24/7. No apps, scripts or files on your PC.',
  },
  {
    icon: ShieldCheck,
    title: 'Ban-safe by design',
    desc: 'Built on Discord\u2019s official RPC SDK and gateway endpoints.',
  },
]

const STEPS = [
  {
    icon: LogIn,
    title: 'Sign in with Discord',
    desc: 'One OAuth click. We never see your password or token.',
  },
  {
    icon: CreditCard,
    title: 'Pick a plan',
    desc: 'Start with a free trial — no card needed. Upgrade when you love it.',
  },
  {
    icon: Radio,
    title: 'Go live',
    desc: 'Configure your presence and watch Discord update in real time.',
  },
]

const STATS = [
  { value: '24/7', label: 'Cloud engine' },
  { value: '11+', label: 'Game presets' },
  { value: '100%', label: 'Official API' },
  { value: '0', label: 'Downloads needed' },
]

const FAQS = [
  {
    q: 'Is 10X RPC safe to use?',
    a: 'Yes. We never ask for your Discord token or password. 10X RPC is built on Discord\u2019s official RPC SDK and gateway endpoints, so your account is never at risk.',
  },
  {
    q: 'Do I need to download anything?',
    a: 'No. 10X RPC runs entirely in our cloud, 24/7. You configure everything from your browser dashboard — no apps, scripts or files on your PC.',
  },
  {
    q: 'How does the free trial work?',
    a: 'Every new account gets a free trial with full feature access — no card needed. When it ends you can pick a plan or keep using the free tier.',
  },
  {
    q: 'What payment methods do you accept?',
    a: 'UPI, cards and netbanking — all processed securely through Razorpay. Prices are shown in Indian Rupees.',
  },
  {
    q: 'Which games are supported?',
    a: 'Ready-made presets ship for Valorant, GTA V, Minecraft, Counter-Strike 2, Genshin Impact, VRChat and more — plus fully custom presence for anything else.',
  },
  {
    q: 'Can I get help or a refund?',
    a: 'Join our Discord server for support. Refunds are handled per our Refund Policy — reach out to the team there.',
  },
]

/* ---------- FAQ item (accordion) ---------- */

function Faq({ q, a, delay }: { q: string; a: string; delay: number }) {
  const [open, setOpen] = useState(false)
  return (
    <Reveal delay={delay}>
      <div className="glass-card-inner overflow-hidden">
        <button
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          className="w-full flex items-center justify-between gap-4 text-left px-5 py-4 hover:bg-white/[0.02] transition-colors"
        >
          <span className="text-sm sm:text-base font-semibold text-white">{q}</span>
          <ChevronDown open={open} />
        </button>
        <div
          className={cn(
            'grid transition-all duration-300 ease-in-out',
            open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
          )}
        >
          <div className="overflow-hidden">
            <p className="px-5 pb-4 text-sm text-white/60 leading-relaxed">{a}</p>
          </div>
        </div>
      </div>
    </Reveal>
  )
}

function ChevronDown({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('w-4 h-4 shrink-0 text-purple-400 transition-transform duration-300', open && 'rotate-180')}
      aria-hidden
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

/* ---------- misc ---------- */

function FeatureCard({ icon: Icon, title, desc, delay }: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  desc: string
  delay: number
}) {
  return (
    <Reveal delay={delay} className="h-full">
      <div className="glass-card-inner p-6 h-full hover:border-purple-500/30 hover:-translate-y-1 transition-all duration-300">
        <div className="w-11 h-11 rounded-xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center mb-4">
          <Icon className="w-5 h-5 text-purple-300" />
        </div>
        <h3 className="text-lg font-bold text-white">{title}</h3>
        <p className="text-sm text-white/60 mt-2 leading-relaxed">{desc}</p>
      </div>
    </Reveal>
  )
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}
