// 10X RPC — Landing page v6 (Cobalt-style template)
// Minimal centered nav → centered hero with starfield, gradient headline and a
// single dark pill CTA → "Simple, honest pricing" (DB-driven; static fallback
// mirrors the live DB catalog) → full-width DASHBOARD APP MOCKUP (sidebar ·
// topbar · stat cards · filter row · glowing violet area chart) → two-column
// statement → bento features grid with live mini-UI mockups → "Meet the engine"
// two-card section → how-it-works + stats → FAQ → final CTA → minimal footer.
// Presence card (Task 78/80) lives inside bento card #1.
'use client'
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Gamepad2, Glasses, Globe2, RefreshCcw, ShieldCheck, Lock, Cloud,
  Menu, X, LogIn, CreditCard, Radio, Check, Monitor,
  LayoutDashboard, Settings, Search, Bell, HelpCircle, Calendar,
  ChevronDown, Filter, ArrowUpRight, MoonStar, Sparkles,
  ChevronsLeft,
} from 'lucide-react'
import { BrandMark, BrandName } from './BrandMark'
import { useRouter } from './useRouter'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { api, type Me } from '@/lib/api-client'
import { DynamicPricing, PricingCard } from './DynamicPricing'

// Shared dark-pill button (Cobalt-style: quiet, bordered, brightens on hover)
const PILL =
  'inline-flex items-center justify-center rounded-full border border-white/10 bg-white/[0.07] font-semibold text-white hover:bg-white/[0.13] hover:border-white/25 active:scale-[0.98] transition-all'

const NAV_LINKS = [
  { label: 'Pricing', href: '#pricing' },
  { label: 'Features', href: '#features' },
  { label: 'FAQ', href: '#faq' },
]

// Deterministic starfield (SSR-safe: fixed positions/delays so server and
// client markup agree). ~32 dots scattered across the hero.
const STARS = [
  { l: '4%', t: '18%', s: 2, d: '0s', du: '3.2s' },
  { l: '9%', t: '42%', s: 1.5, d: '0.6s', du: '4.1s' },
  { l: '13%', t: '12%', s: 2, d: '1.2s', du: '3.6s' },
  { l: '18%', t: '62%', s: 1.5, d: '0.3s', du: '4.4s' },
  { l: '22%', t: '28%', s: 2.5, d: '1.8s', du: '3.1s' },
  { l: '27%', t: '48%', s: 1.5, d: '2.4s', du: '3.8s' },
  { l: '31%', t: '8%', s: 2, d: '0.9s', du: '4.2s' },
  { l: '35%', t: '70%', s: 2, d: '1.5s', du: '3.3s' },
  { l: '39%', t: '20%', s: 1.5, d: '2.1s', du: '4.6s' },
  { l: '43%', t: '55%', s: 2.5, d: '0.4s', du: '3.5s' },
  { l: '47%', t: '14%', s: 1.5, d: '2.8s', du: '3.9s' },
  { l: '51%', t: '38%', s: 2, d: '1.1s', du: '4.3s' },
  { l: '55%', t: '66%', s: 1.5, d: '0.7s', du: '3.4s' },
  { l: '59%', t: '24%', s: 2, d: '1.9s', du: '4.0s' },
  { l: '63%', t: '50%', s: 2.5, d: '2.6s', du: '3.7s' },
  { l: '67%', t: '10%', s: 1.5, d: '0.2s', du: '4.5s' },
  { l: '71%', t: '58%', s: 2, d: '1.4s', du: '3.2s' },
  { l: '75%', t: '34%', s: 1.5, d: '2.2s', du: '4.1s' },
  { l: '79%', t: '16%', s: 2, d: '0.8s', du: '3.6s' },
  { l: '83%', t: '64%', s: 2, d: '1.7s', du: '4.4s' },
  { l: '87%', t: '40%', s: 1.5, d: '0.5s', du: '3.8s' },
  { l: '91%', t: '22%', s: 2.5, d: '2.0s', du: '3.3s' },
  { l: '95%', t: '52%', s: 1.5, d: '1.3s', du: '4.2s' },
  { l: '97%', t: '8%', s: 2, d: '2.5s', du: '3.9s' },
  { l: '16%', t: '80%', s: 1.5, d: '0.9s', du: '4.0s' },
  { l: '44%', t: '84%', s: 2, d: '1.6s', du: '3.4s' },
  { l: '69%', t: '82%', s: 1.5, d: '0.3s', du: '4.3s' },
  { l: '90%', t: '78%', s: 2, d: '2.3s', du: '3.6s' },
  { l: '6%', t: '68%', s: 1.5, d: '1.0s', du: '3.7s' },
  { l: '26%', t: '88%', s: 2, d: '2.7s', du: '4.1s' },
  { l: '58%', t: '90%', s: 1.5, d: '0.6s', du: '3.5s' },
  { l: '81%', t: '90%', s: 2, d: '1.2s', du: '4.4s' },
]

const GAMES = [
  { name: 'Valorant', color: '#FF4655' },
  { name: 'GTA V', color: '#5CBE6C' },
  { name: 'Minecraft', color: '#8BC34A' },
  { name: 'Counter-Strike 2', color: '#F59E0B' },
  { name: 'Genshin Impact', color: '#22D3EE' },
  { name: 'VRChat', color: '#9C89F8' },
  { name: 'Wuthering Waves', color: '#A78BFA' },
  { name: 'Forza Horizon 5', color: '#C084FC' },
  { name: 'Arknights', color: '#FBBF24' },
  { name: 'Roblox', color: '#F87171' },
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
    return () => window.removeEventListener('scroll', onScroll, {})
  }, [])

  const onStart = () => {
    if (me?.authenticated) navigate({ name: 'dashboard' })
    else window.location.href = '/auth/discord'
  }

  const trialDays = me?.trialDays ?? 3
  const startLabel = loading ? 'Loading...' : `Start ${trialDays} Days Free`

  return (
    <div className="min-h-screen flex flex-col bg-[#020205]">
      {/* ============ NAV (minimal) ============ */}
      <nav
        className={cn(
          'sticky top-0 z-50 transition-all duration-300',
          scrolled
            ? 'bg-[#020205]/85 backdrop-blur-xl border-b border-white/8'
            : 'bg-transparent border-b border-transparent'
        )}
      >
        <div className="max-w-6xl mx-auto flex items-center justify-between px-4 sm:px-6 py-3.5">
          <button onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} className="flex items-center gap-2" aria-label="10X RPC — back to top">
            <BrandMark className="w-8 h-8" />
            <BrandName className="text-base sm:text-lg font-bold" suffix=" RPC" />
          </button>

          <div className="hidden md:flex items-center gap-1">
            {NAV_LINKS.map(l => (
              <a key={l.href} href={l.href} className="text-sm text-white/60 hover:text-white px-3 py-2 rounded-lg hover:bg-white/5 transition-colors">
                {l.label}
              </a>
            ))}
          </div>

          <div className="hidden md:block">
            <button onClick={onStart} disabled={loading} className={cn(PILL, 'px-4.5 py-2 text-sm')}>
              {me?.authenticated ? 'Open Dashboard' : 'Start Free'}
            </button>
          </div>

          <button
            className="md:hidden text-white/80 hover:text-white p-2 -mr-2"
            onClick={() => setMenuOpen(o => !o)}
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
          >
            {menuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </div>

        {/* Mobile menu */}
        {menuOpen && (
          <div className="md:hidden border-t border-white/8 bg-[#020205]/95 backdrop-blur-xl">
            <div className="px-4 py-3 flex flex-col gap-1">
              {NAV_LINKS.map(l => (
                <a key={l.href} href={l.href} onClick={() => setMenuOpen(false)} className="text-sm text-white/80 hover:text-white px-3 py-2.5 rounded-lg hover:bg-white/5 transition-colors">
                  {l.label}
                </a>
              ))}
              <button
                onClick={() => { setMenuOpen(false); onStart() }}
                className={cn(PILL, 'mt-2 px-5 py-3 text-sm')}
              >
                {me?.authenticated ? 'Open Dashboard' : 'Start Free'}
              </button>
            </div>
          </div>
        )}
      </nav>

      <main className="flex-1 flex flex-col">
        {/* ============ HERO (centered, starfield) ============ */}
        <section className="relative overflow-hidden">
          {/* deep nebula glows */}
          <div className="absolute -top-48 left-1/2 -translate-x-1/2 w-[760px] h-[460px] rounded-full bg-[#4C1D95]/25 blur-[150px] pointer-events-none" aria-hidden />
          <div className="absolute top-10 left-[10%] w-72 h-72 bg-blue-600/10 rounded-full blur-[130px] pointer-events-none" aria-hidden />
          <div className="absolute top-24 right-[6%] w-80 h-80 bg-violet-600/10 rounded-full blur-[130px] pointer-events-none" aria-hidden />

          {/* starfield */}
          {STARS.map((st, i) => (
            <span
              key={i}
              className="star pointer-events-none"
              style={{ left: st.l, top: st.t, width: st.s, height: st.s, animationDelay: st.d, animationDuration: st.du }}
              aria-hidden
            />
          ))}

          <div className="relative max-w-4xl mx-auto px-4 sm:px-6 pt-20 sm:pt-28 pb-14 sm:pb-20 text-center">
            <motion.h1
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6 }}
              className="text-5xl sm:text-7xl font-black tracking-tight leading-[1.05]"
            >
              <span className="bg-gradient-to-b from-white via-white to-white/40 bg-clip-text text-transparent">
                Your Discord presence,
                <br />
                <BrandName /> better.
              </span>
            </motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.1 }}
              className="mt-6 text-base sm:text-lg text-white/60 max-w-2xl mx-auto leading-relaxed"
            >
              The ultimate cloud-powered Rich Presence engine. Custom status, game
              RPC, VR presence and dynamic placeholders — running 24/7, with
              nothing to download and no token required.
            </motion.p>

            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.2 }}
              className="mt-9"
            >
              <button
                onClick={onStart}
                disabled={loading}
                className={cn(PILL, 'px-8 py-3.5 text-sm sm:text-base shadow-[0_10px_44px_-12px_rgba(139,92,246,0.45)]')}
              >
                {startLabel}
              </button>
            </motion.div>

          </div>
        </section>

        {/* ============ PRICING (top — right after hero, DB-driven) ============ */}
        <section id="pricing" className="relative px-4 sm:px-6 pt-4 sm:pt-8 pb-20 sm:pb-28 scroll-mt-20 overflow-hidden">
          <div className="absolute top-16 left-1/2 -translate-x-1/2 w-[640px] h-[320px] bg-violet-600/10 rounded-full blur-[130px] pointer-events-none" aria-hidden />
          <div className="relative max-w-5xl mx-auto">
            <SectionHeading
              eyebrow="Pricing"
              title="Simple, honest pricing"
              sub="Every account starts with a free trial — no card needed. Pay with UPI, cards or netbanking via Razorpay."
            />
            <Reveal delay={0.08}>
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
            </Reveal>
            <p className="text-center text-xs text-white/40 mt-8">
              Prices are managed live by the 10X RPC team — what you see here is always current.
            </p>
          </div>
        </section>

        {/* ============ DASHBOARD APP MOCKUP ============ */}
        <section id="product" className="relative px-4 sm:px-6 pb-20 sm:pb-28 scroll-mt-20">
          <Reveal>
            <div className="max-w-6xl mx-auto rounded-2xl border border-white/10 bg-[#07080C] shadow-[0_40px_120px_-40px_rgba(0,0,0,0.9)] overflow-hidden">
              <div className="flex">
                {/* Sidebar */}
                <aside className="hidden md:flex w-52 shrink-0 flex-col border-r border-white/5 bg-[#08090E] p-3">
                  <div className="flex items-center justify-between px-2 py-1.5">
                    <BrandMark className="w-6 h-6" />
                    <ChevronsLeft className="w-4 h-4 text-white/25" aria-hidden />
                  </div>
                  <nav className="mt-4 flex flex-col gap-0.5" aria-label="Dashboard preview">
                    <SidebarItem icon={LayoutDashboard} label="Dashboard" active />
                    <SidebarItem icon={Radio} label="Rich Presence" />
                    <SidebarItem icon={Gamepad2} label="Gamer RPC" />
                    <SidebarItem icon={Glasses} label="VR Status" />
                    <SidebarItem icon={RefreshCcw} label="Status Rotator" />
                    <SidebarItem icon={Globe2} label="Placeholders" />
                  </nav>
                  <div className="mt-auto pt-4 flex flex-col gap-0.5 border-t border-white/5">
                    <SidebarItem icon={Settings} label="Settings" />
                    <SidebarItem icon={HelpCircle} label="Support" />
                  </div>
                </aside>

                {/* Main panel */}
                <div className="flex-1 min-w-0 p-3.5 sm:p-5">
                  {/* topbar */}
                  <div className="flex items-center gap-3">
                    <div className="hidden sm:flex flex-1 items-center gap-2 bg-white/[0.03] border border-white/8 rounded-lg px-3 py-2 max-w-xs">
                      <Search className="w-3.5 h-3.5 text-white/35" aria-hidden />
                      <span className="text-xs text-white/35">Search anything...</span>
                      <span className="ml-auto text-[10px] text-white/30 border border-white/10 rounded px-1.5 py-0.5 font-mono">⌘K</span>
                    </div>
                    <div className="ml-auto flex items-center gap-3">
                      <HelpCircle className="w-4 h-4 text-white/40" aria-hidden />
                      <Bell className="w-4 h-4 text-white/40" aria-hidden />
                      <Settings className="w-4 h-4 text-white/40" aria-hidden />
                      <span className="w-7 h-7 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-600 text-[10px] font-bold text-white flex items-center justify-center ring-1 ring-white/20">10</span>
                    </div>
                  </div>

                  {/* stat cards */}
                  <div className="mt-4 grid grid-cols-2 lg:grid-cols-4 gap-3">
                    <div className="bg-white/[0.02] border border-white/5 rounded-xl p-4">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[11px] text-white/50">Sessions today</p>
                        <span className="text-[10px] font-semibold text-[#3BA55C] bg-[#23A559]/10 border border-[#23A559]/25 rounded px-1.5 py-0.5">+28%</span>
                      </div>
                      <p className="mt-2 text-xl font-bold text-white">1,038<span className="text-white/40 text-sm">.82</span></p>
                      <p className="mt-1.5 flex items-center gap-1 text-[10px] text-white/40"><RefreshCcw className="w-3 h-3" aria-hidden /> Live · updated 12s ago</p>
                      <div className="mt-3 flex gap-1">
                        {['7d', '30d', '90d'].map(k => (
                          <span key={k} className="text-[9px] font-mono text-white/40 border border-white/10 rounded px-1.5 py-0.5">{k}</span>
                        ))}
                      </div>
                    </div>

                    <div className="bg-white/[0.02] border border-white/5 rounded-xl p-4">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[11px] text-white/50">Avg session</p>
                        <span className="text-[10px] font-semibold text-violet-300 bg-violet-500/10 border border-violet-500/25 rounded px-1.5 py-0.5">+5.7%</span>
                      </div>
                      <p className="mt-2 text-xl font-bold text-white">6h 12m<span className="text-white/40 text-sm">.82</span></p>
                      <div className="mt-8 flex justify-end">
                        <ArrowUpRight className="w-3.5 h-3.5 text-white/25" aria-hidden />
                      </div>
                    </div>

                    <div className="bg-white/[0.02] border border-white/5 rounded-xl p-4">
                      <p className="text-[11px] text-white/50">Presence uptime</p>
                      <div className="mt-3 space-y-2">
                        <p className="flex items-center gap-2 text-xs text-white/80">
                          <span className="w-4 h-4 rounded-full bg-violet-500/20 ring-1 ring-violet-400/40 flex items-center justify-center text-[8px] font-bold text-violet-300">U</span>
                          99.98% this month
                        </p>
                        <p className="flex items-center gap-2 text-xs text-white/80">
                          <span className="w-4 h-4 rounded-full bg-[#23A559]/20 ring-1 ring-[#23A559]/40 flex items-center justify-center text-[8px] font-bold text-[#3BA55C]">C</span>
                          24/7 always on
                        </p>
                      </div>
                    </div>

                    <div className="bg-white/[0.02] border border-white/5 rounded-xl p-4">
                      <p className="text-[11px] text-white/50">Profile engagement</p>
                      <p className="mt-2 flex items-center gap-1 text-xl font-bold text-white">
                        <ArrowUpRight className="w-4 h-4 text-violet-300" aria-hidden /> 72%
                      </p>
                      <p className="mt-1.5 text-[10px] text-white/40 leading-relaxed">Your presence views grew significantly in the last 30 days.</p>
                      <div className="mt-2 flex justify-end">
                        <ArrowUpRight className="w-3.5 h-3.5 text-white/25" aria-hidden />
                      </div>
                    </div>
                  </div>

                  {/* filter row */}
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <FilterPill label="Last 4 weeks" caret />
                    <FilterPill icon={<Calendar className="w-3 h-3" />} label="May 12 – Jun 9" />
                    <span className="text-[11px] text-white/30 hidden lg:inline">compared to</span>
                    <FilterPill label="Previous period" caret className="hidden lg:flex" />
                    <div className="ml-auto flex items-center gap-2">
                      <div className="flex rounded-lg border border-white/8 overflow-hidden text-[11px]" role="group" aria-label="Chart granularity">
                        <span className="px-3 py-1.5 text-white/45">Daily</span>
                        <span className="px-3 py-1.5 bg-white/[0.07] text-white font-medium">Weekly</span>
                      </div>
                      <span className="flex items-center gap-1.5 bg-violet-600 text-white text-[11px] font-semibold rounded-lg px-3 py-1.5 shadow-[0_4px_16px_-4px_rgba(139,92,246,0.6)]">
                        <Filter className="w-3 h-3" aria-hidden /> Filter
                      </span>
                    </div>
                  </div>

                  {/* chart */}
                  <div className="mt-4 relative rounded-xl border border-white/5 bg-white/[0.015] p-3 sm:p-4">
                    <div className="flex gap-6">
                      <div>
                        <p className="text-[10px] text-white/40">Presence views</p>
                        <p className="text-sm font-bold text-white">12,482<span className="text-[10px] text-white/35">.37</span></p>
                      </div>
                      <div>
                        <p className="text-[10px] text-white/40">Active hours</p>
                        <p className="text-sm font-bold text-white">712<span className="text-[10px] text-white/35">.55</span></p>
                      </div>
                    </div>
                    <div className="relative mt-2 h-44 sm:h-60">
                      <svg className="absolute inset-0 w-full h-full" viewBox="0 0 1000 300" preserveAspectRatio="none" aria-hidden>
                        <defs>
                          <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#8B5CF6" stopOpacity="0.22" />
                            <stop offset="100%" stopColor="#8B5CF6" stopOpacity="0" />
                          </linearGradient>
                        </defs>
                        {/* comparison line (previous period) */}
                        <path d="M0,252 C70,244 130,228 210,234 C290,240 350,210 430,214 C510,218 570,190 650,196 C730,202 790,172 870,180 C930,186 970,176 1000,172" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
                        {/* area fill */}
                        <path d="M0,232 C55,214 95,184 150,190 C205,196 235,128 292,117 C342,108 372,150 420,158 C468,166 502,94 560,82 C612,72 642,120 692,128 C742,136 772,58 830,48 C882,40 922,92 1000,112 L1000,300 L0,300 Z" fill="url(#areaFill)" />
                        {/* main glowing line */}
                        <path d="M0,232 C55,214 95,184 150,190 C205,196 235,128 292,117 C342,108 372,150 420,158 C468,166 502,94 560,82 C612,72 642,120 692,128 C742,136 772,58 830,48 C882,40 922,92 1000,112" fill="none" stroke="#A78BFA" strokeWidth="2.5" vectorEffect="non-scaling-stroke" className="chart-line-glow" />
                        {/* tooltip guide */}
                        <line x1="830" y1="48" x2="830" y2="300" stroke="rgba(167,139,250,0.4)" strokeWidth="1.5" strokeDasharray="4 5" vectorEffect="non-scaling-stroke" />
                        <circle cx="830" cy="48" r="5" fill="#A78BFA" />
                      </svg>

                      {/* tooltip card */}
                      <div className="absolute right-[5%] top-0 bg-[#101218]/95 border border-white/10 rounded-lg px-3 py-2 shadow-xl">
                        <p className="text-[10px] font-semibold text-white/80">Wed, Jun 4</p>
                        <p className="mt-0.5 text-[10px] text-white/55 flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-violet-400" aria-hidden /> 1,248 sessions
                        </p>
                        <p className="text-[10px] text-white/55 flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-white/30" aria-hidden /> 1,090 previous
                        </p>
                      </div>

                      {/* y-axis labels */}
                      <span className="absolute right-1 top-[8%] text-[10px] text-white/30">2.4K</span>
                      <span className="absolute right-1 top-[46%] text-[10px] text-white/30">1.0K</span>
                      <span className="absolute right-1 bottom-[4%] text-[10px] text-white/30">300</span>
                    </div>
                    <div className="mt-1.5 flex justify-between text-[10px] text-white/30">
                      <span>May 12</span>
                      <span className="hidden sm:inline">May 26</span>
                      <span>Jun 9</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Reveal>
        </section>

        {/* ============ STATEMENT ============ */}
        <section className="px-4 sm:px-6 py-16 sm:py-24">
          <div className="max-w-6xl mx-auto grid md:grid-cols-2 gap-10 md:gap-16 items-start">
            <Reveal>
              <h2 className="text-4xl sm:text-5xl font-black tracking-tight leading-[1.08]">
                <span className="bg-gradient-to-b from-white via-white to-white/45 bg-clip-text text-transparent">
                  Who said status has to be boring?
                </span>
              </h2>
            </Reveal>
            <Reveal delay={0.08}>
              <p className="text-base sm:text-lg text-white/60 leading-relaxed">
                With 10X RPC, managing your Discord presence is effortless,
                empowering, and anything but boring. Our cloud engine brings your
                status to life, simplifies every preset, and puts the power of
                advanced Rich Presence right at your fingertips.{' '}
                <strong className="text-white font-semibold">Say no to clunky clients and tools designed in the 80s.</strong>
              </p>
            </Reveal>
          </div>

          {/* safety strip (quiet) */}
          <div className="max-w-6xl mx-auto mt-14 sm:mt-20 grid sm:grid-cols-3 gap-6">
            {SAFETY.map((s, i) => (
              <Reveal key={s.title} delay={i * 0.06}>
                <div className="flex items-start gap-3.5">
                  <div className="shrink-0 w-10 h-10 rounded-xl bg-white/[0.04] border border-white/8 flex items-center justify-center">
                    <s.icon className="w-4.5 h-4.5 text-violet-300" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-white text-sm">{s.title}</h3>
                    <p className="text-xs text-white/50 mt-1 leading-relaxed">{s.desc}</p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </section>

        {/* ============ BENTO FEATURES ============ */}
        <section id="features" className="relative px-4 sm:px-6 py-16 sm:py-24 scroll-mt-20">
          <span id="seamless" aria-hidden className="absolute" /> {/* legacy bookmark anchor */}
          <div className="max-w-6xl mx-auto">
            <div className="max-w-2xl">
              <Reveal>
                <h2 className="text-4xl sm:text-5xl font-black tracking-tight leading-[1.08]">
                  <span className="bg-gradient-to-b from-white via-white to-white/45 bg-clip-text text-transparent">
                    Everything you need.<br />Nothing you don&rsquo;t.
                  </span>
                </h2>
              </Reveal>
              <Reveal delay={0.08}>
                <p className="mt-5 text-base sm:text-lg text-white/60 leading-relaxed">
                  Presence management and visibility in one place. Experience a{' '}
                  <strong className="text-white font-semibold">flexible toolkit</strong> that makes every task feel like a breeze.
                </p>
              </Reveal>
            </div>

            <div className="mt-12 grid gap-4 md:grid-cols-3">
              <BentoCard title="Live presence preview" desc="Details, state, images, buttons and timers — rendered exactly how Discord renders them for your friends. What you see is what they get." delay={0}>
                <PresenceMiniCard />
              </BentoCard>
              <BentoCard title="One-click game presets" desc="Ready-made presets for Valorant, GTA V, Minecraft, CS2 and more — real game imagery, elapsed timers, zero setup." delay={0.06}>
                <GamePresetsPanel />
              </BentoCard>
              <BentoCard title="Automations on autopilot" desc="Rotators, sleep timers and placeholders run in our cloud around the clock — nothing to keep open, nothing to remember." delay={0.12}>
                <AutomationsPanel />
              </BentoCard>
            </div>

            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <BentoCard title="Works with your games" desc="Built-in presets for the titles you actually play — plus fully custom presence for everything else." delay={0}>
                <div className="grid grid-cols-3 sm:grid-cols-5 gap-3 min-h-[260px] sm:min-h-[300px] content-center">
                  {GAMES.map(g => (
                    <span key={g.name} className="flex items-center justify-center gap-1.5 rounded-xl border border-white/8 bg-white/[0.02] px-2 py-3.5 text-[11px] text-white/70 whitespace-nowrap">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: g.color }} aria-hidden />
                      {g.name}
                    </span>
                  ))}
                </div>
              </BentoCard>
              <BentoCard title="You're in control" desc="Lightning-fast dashboard with shortcuts for everything. Dark mode, obviously." delay={0.06}>
                <CommandPalette />
              </BentoCard>
            </div>
          </div>
        </section>

        {/* ============ MEET THE ENGINE ============ */}
        <section className="px-4 sm:px-6 py-16 sm:py-24">
          <div className="max-w-6xl mx-auto">
            <div className="max-w-2xl">
              <Reveal>
                <h2 className="text-4xl sm:text-5xl font-black tracking-tight">
                  <span className="bg-gradient-to-b from-white via-white to-white/45 bg-clip-text text-transparent">
                    Meet the engine
                  </span>
                </h2>
              </Reveal>
              <Reveal delay={0.08}>
                <p className="mt-5 text-base sm:text-lg text-white/60 leading-relaxed">
                  The cloud daemon behind your status handles the complex parts —{' '}
                  <strong className="text-white font-semibold">scheduling, rotating and refreshing</strong> — automatically.
                </p>
              </Reveal>
            </div>

            <div className="mt-12 grid gap-4 md:grid-cols-2">
              <BentoCard title="Smart scheduling" desc="Rotators, timers and auto-offline schedules map out your presence day — so your status never goes stale." delay={0}>
                <SchedulingChart />
              </BentoCard>
              <BentoCard title="Live dynamic placeholders" desc="Weather, clock, city and more pulled straight into your status — refreshed automatically, all day long." delay={0.06}>
                <PlaceholderBar />
              </BentoCard>
            </div>
          </div>
        </section>

        {/* ============ HOW IT WORKS + STATS ============ */}
        <section id="how" className="px-4 sm:px-6 py-16 sm:py-24 scroll-mt-20">
          <div className="max-w-6xl mx-auto">
            <SectionHeading
              eyebrow="How it works"
              title="Live in under 2 minutes"
              sub="No downloads, no code, no Discord token — just three steps."
            />
            <div className="grid md:grid-cols-3 gap-10 md:gap-8">
              {STEPS.map((s, i) => (
                <Reveal key={s.title} delay={i * 0.08}>
                  <div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-mono text-violet-300/80">0{i + 1}</span>
                      <span className="h-px flex-1 bg-white/8" aria-hidden />
                      <s.icon className="w-4 h-4 text-white/40" aria-hidden />
                    </div>
                    <h3 className="mt-4 text-lg font-bold text-white">{s.title}</h3>
                    <p className="mt-2 text-sm text-white/55 leading-relaxed">{s.desc}</p>
                  </div>
                </Reveal>
              ))}
            </div>

            <Reveal delay={0.15}>
              <div className="mt-16 pt-10 border-t border-white/5 grid grid-cols-2 md:grid-cols-4 gap-6">
                {STATS.map(s => (
                  <div key={s.label}>
                    <div className="text-3xl sm:text-4xl font-black text-white">{s.value}</div>
                    <div className="text-xs text-white/40 mt-1.5">{s.label}</div>
                  </div>
                ))}
              </div>
            </Reveal>
          </div>
        </section>

        {/* ============ FAQ ============ */}
        <section id="faq" className="px-4 sm:px-6 py-16 sm:py-24 scroll-mt-20">
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
        <section className="px-4 sm:px-6 py-24 sm:py-32 relative overflow-hidden">
          <div className="absolute -top-24 left-1/2 -translate-x-1/2 w-[560px] h-[300px] bg-violet-600/12 rounded-full blur-[120px] pointer-events-none" aria-hidden />
          <Reveal>
            <div className="relative max-w-3xl mx-auto text-center">
              <h2 className="text-4xl sm:text-6xl font-black tracking-tight leading-[1.06]">
                <span className="bg-gradient-to-b from-white via-white to-white/40 bg-clip-text text-transparent">
                  See where your presence can take you.
                </span>
              </h2>
              <p className="mt-5 text-white/55 text-base sm:text-lg">
                The first presence tool you&rsquo;ll love. And the last one you&rsquo;ll ever need.
              </p>
              <div className="mt-9">
                <button
                  onClick={onStart}
                  disabled={loading}
                  className={cn(PILL, 'px-8 py-3.5 text-sm sm:text-base shadow-[0_10px_44px_-12px_rgba(139,92,246,0.45)]')}
                >
                  {me?.authenticated ? 'Open Dashboard' : startLabel}
                </button>
              </div>
              <p className="mt-5 text-xs text-white/40 flex items-center justify-center gap-1.5">
                <Check className="w-3.5 h-3.5 text-violet-300" aria-hidden /> No card needed
                <span className="text-white/20">·</span> Cancel anytime
              </p>
            </div>
          </Reveal>
        </section>
      </main>

      {/* ============ FOOTER (minimal) ============ */}
      <footer className="mt-auto border-t border-white/5 bg-black/30">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-10">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-white/40">
              <span>© 2026 10X RPC. All rights reserved.</span>
              <a href="#" className="hover:text-white/75 transition-colors">Privacy Policy</a>
              <a href="#" className="hover:text-white/75 transition-colors">Terms of Use</a>
              <a href="#" className="hover:text-white/75 transition-colors">Refund Policy</a>
              <a href="/uptime" className="hover:text-white/75 transition-colors">Uptime</a>
              <a href="/games" className="hover:text-white/75 transition-colors">Games</a>
            </div>
            <div className="flex items-center gap-2">
              <a
                href="https://discord.gg/FZvJfZx2V5"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="10X RPC on Discord"
                className="w-8 h-8 rounded-lg border border-white/8 bg-white/[0.03] flex items-center justify-center text-white/50 hover:text-white hover:bg-white/[0.08] transition-colors"
              >
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4" aria-hidden>
                  <path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.058a.082.082 0 0 0 .031.056 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03ZM8.02 15.331c-1.182 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418Zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418Z" />
                </svg>
              </a>
              <a
                href="https://10x-rpc.vercel.app"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="10X RPC website"
                className="w-8 h-8 rounded-lg border border-white/8 bg-white/[0.03] flex items-center justify-center text-white/50 hover:text-white hover:bg-white/[0.08] transition-colors"
              >
                <Globe2 className="w-4 h-4" aria-hidden />
              </a>
            </div>
          </div>
          <p className="mt-6 text-[11px] leading-relaxed text-white/25 max-w-3xl">
            10X RPC is not affiliated with, endorsed, or sponsored by Discord Inc.
            Presence runs on Discord&rsquo;s official RPC SDK and gateway endpoints — no tokens, no downloads, 24/7 cloud.
          </p>
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

/* ---------- section heading (minimal) ---------- */

function SectionHeading({ eyebrow, title, sub }: { eyebrow: string; title: string; sub?: string }) {
  return (
    <Reveal className="text-center max-w-2xl mx-auto mb-12 sm:mb-14">
      <p className="text-[11px] font-semibold uppercase tracking-[0.25em] text-white/40">{eyebrow}</p>
      <h2 className="mt-3 text-3xl sm:text-5xl font-black text-white tracking-tight">{title}</h2>
      {sub && <p className="mt-4 text-base text-white/55 leading-relaxed">{sub}</p>}
    </Reveal>
  )
}

/* ---------- dashboard mockup helpers ---------- */

function SidebarItem({ icon: Icon, label, active }: { icon: React.ComponentType<{ className?: string }>; label: string; active?: boolean }) {
  return (
    <span
      className={cn(
        'flex items-center gap-2.5 rounded-lg px-3 py-2 text-xs font-medium',
        active ? 'bg-white/[0.06] text-white' : 'text-white/45'
      )}
    >
      <Icon className="w-3.5 h-3.5" aria-hidden />
      {label}
    </span>
  )
}

function FilterPill({ icon, label, caret, className }: { icon?: React.ReactNode; label: string; caret?: boolean; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[11px] text-white/60 bg-white/[0.03] border border-white/8 rounded-lg px-3 py-1.5', className)}>
      {icon}
      {label}
      {caret && <ChevronDown className="w-3 h-3 text-white/35" aria-hidden />}
    </span>
  )
}

/* ---------- bento card shell ---------- */

function BentoCard({ children, title, desc, delay, className }: {
  children: React.ReactNode
  title: string
  desc: string
  delay?: number
  className?: string
}) {
  return (
    <Reveal delay={delay} className={className}>
      <div className="group h-full rounded-2xl border border-white/5 bg-[#0A0C11] p-5 sm:p-6 premium-hover">
        <div className="mb-6">{children}</div>
        <h3 className="text-base sm:text-lg font-bold text-white">{title}</h3>
        <p className="mt-2 text-sm text-white/55 leading-relaxed">{desc}</p>
      </div>
    </Reveal>
  )
}

/* ---------- bento visual: live presence card (mini) ---------- */

// Live mini version of the real 10X RPC presence (Task 78/80 replica).
function PresenceMiniCard() {
  const start = useState(() => Date.now() - 193_000)[0] // timer reads 3:13 on first paint
  // Seed `now` with `start` (not Date.now()) so SSR and hydration agree on the
  // first render; the interval takes over right after mount.
  const [now, setNow] = useState(start)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const elapsed = formatClock(Math.max(0, now - start))

  return (
    <div className="bg-[#1a1b22] border border-white/10 rounded-xl p-4 shadow-lg">
      <p className="text-[11px] text-white/45">Current activity</p>
      <p className="mt-1.5 text-xs font-semibold text-white/90">
        Watching on Meta Quest <span className="text-white/50" aria-hidden>∞</span>
      </p>
      <div className="mt-3 flex items-start gap-3">
        <BrandMark className="w-12 h-12 shrink-0" rounded="rounded-lg" />
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-bold text-white leading-snug break-words">
            🚀 10X RPC | ⚙️ RPC Control | 🎁 Free Access
          </p>
          <p className="mt-0.5 text-[10px] text-white/60 leading-snug break-words">
            🚀 Custom Discord RPC | No Token Required
          </p>
          <p className="mt-1 flex items-center gap-1.5 text-[11px] font-mono font-semibold text-[#23A559]">
            <Monitor className="w-3 h-3 shrink-0" aria-hidden />
            <span>{elapsed}</span>
          </p>
          <div className="mt-2.5 flex flex-col gap-1.5">
            <a
              href="https://discord.gg/FZvJfZx2V5"
              target="_blank"
              rel="noopener noreferrer"
              className="bg-[#4e5058] hover:bg-[#5f6168] text-white text-[10px] font-semibold rounded-md px-2 py-1.5 text-center whitespace-nowrap transition-colors"
            >
              ⚙️ .gg/10X RPC
            </a>
            <a
              href="https://10x-rpc.vercel.app"
              target="_blank"
              rel="noopener noreferrer"
              className="bg-[#4e5058] hover:bg-[#5f6168] text-white text-[10px] font-semibold rounded-md px-2 py-1.5 text-center whitespace-nowrap transition-colors"
            >
              📅 10X RPC WEBSITE
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ---------- bento visual: gamer presets panel ---------- */

const PRESET_ROWS = [
  { name: 'Valorant', color: '#FF4655', on: true },
  { name: 'GTA V', color: '#5CBE6C', on: true },
  { name: 'Minecraft', color: '#8BC34A', on: false },
  { name: 'Counter-Strike 2', color: '#F59E0B', on: false },
]

function GamePresetsPanel() {
  return (
    <div className="bg-[#0C0E14] border border-white/8 rounded-xl p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-white">Gamer RPC</p>
        <Settings className="w-3.5 h-3.5 text-white/35" aria-hidden />
      </div>
      <div className="mt-3 space-y-2">
        {PRESET_ROWS.map(g => (
          <div key={g.name} className="flex items-center gap-2.5 rounded-lg bg-white/[0.02] border border-white/5 px-3 py-2">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: g.color }} aria-hidden />
            <span className="text-[11px] text-white/75">{g.name}</span>
            <span
              className={cn(
                'ml-auto relative w-7 h-4 rounded-full shrink-0 transition-colors',
                g.on ? 'bg-violet-600' : 'bg-white/10'
              )}
              aria-hidden
            >
              <span className={cn('absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all', g.on ? 'left-3.5' : 'left-0.5')} />
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ---------- bento visual: automations / alerts ---------- */

function AutomationsPanel() {
  return (
    <div className="space-y-2.5">
      <div className="bg-[#0C0E14] border border-white/8 rounded-xl p-3.5">
        <div className="flex items-center gap-1.5 text-[10px] text-white/40">
          <BrandMark className="w-3.5 h-3.5" rounded="rounded" /> 10X RPC · 2m ago
        </div>
        <p className="mt-1.5 text-xs font-semibold text-white">🔄 Rotator switched to &ldquo;Valorant preset&rdquo;</p>
        <div className="mt-2.5 flex gap-1.5">
          {['Pause', 'Edit', 'Keep'].map(c => (
            <span key={c} className="text-[10px] px-2 py-1 rounded-md bg-white/[0.05] border border-white/8 text-white/70">{c}</span>
          ))}
        </div>
      </div>
      <div className="bg-[#0C0E14] border border-white/8 rounded-xl p-3.5 opacity-75">
        <div className="flex items-center gap-1.5 text-[10px] text-white/40">
          <MoonStar className="w-3.5 h-3.5" aria-hidden /> Sleep timer · 1h ago
        </div>
        <p className="mt-1.5 text-xs font-semibold text-white">😴 Armed — going offline at 02:15</p>
      </div>
    </div>
  )
}

/* ---------- bento visual: command palette ---------- */

const PALETTE_SECTIONS = [
  {
    label: 'Frequently used',
    rows: [
      { icon: Monitor, label: 'View live preview', kbd: '⌘P' },
      { icon: RefreshCcw, label: 'Rotate status', kbd: '⌘R' },
      { icon: Globe2, label: 'Manage placeholders', kbd: '⌘E' },
    ],
  },
  {
    label: 'Settings & help',
    rows: [
      { icon: Settings, label: 'Manage settings', kbd: '⌘S' },
      { icon: HelpCircle, label: 'Contact support', kbd: '⌘H' },
    ],
  },
]

function CommandPalette() {
  return (
    <div className="bg-[#0C0E14] border border-white/8 rounded-xl p-4 max-w-sm mx-auto">
      <p className="text-xs font-semibold text-white">What would you like to do?</p>
      {PALETTE_SECTIONS.map(sec => (
        <div key={sec.label} className="mt-3">
          <p className="text-[9px] font-semibold uppercase tracking-wider text-white/30">{sec.label}</p>
          <div className="mt-1.5 space-y-1">
            {sec.rows.map(r => (
              <div key={r.label} className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-2.5 py-1.5 text-[11px] text-white/70">
                <r.icon className="w-3.5 h-3.5 text-white/40" aria-hidden />
                {r.label}
                <span className="ml-auto text-[9px] font-mono text-white/40 border border-white/10 rounded px-1 py-0.5">{r.kbd}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/* ---------- engine visual: scheduling chart ---------- */

function SchedulingChart() {
  return (
    <div className="relative h-40 sm:h-48 rounded-xl border border-white/5 bg-white/[0.015] overflow-hidden">
      <svg className="absolute inset-0 w-full h-full" viewBox="0 0 600 200" preserveAspectRatio="none" aria-hidden>
        {/* history (solid) */}
        <path d="M0,64 C60,54 120,96 200,112 C280,128 330,158 400,150" fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        {/* forecast (dashed violet) */}
        <path d="M400,150 C460,143 510,120 600,130" fill="none" stroke="#A78BFA" strokeWidth="2.5" strokeDasharray="6 6" vectorEffect="non-scaling-stroke" className="chart-line-glow" />
        <circle cx="400" cy="150" r="4" fill="#A78BFA" />
      </svg>
      <div className="absolute left-4 top-4 bg-[#101218]/95 border border-white/10 rounded-lg px-3 py-2 flex items-start gap-2 shadow-lg">
        <MoonStar className="w-3.5 h-3.5 text-violet-300 mt-0.5 shrink-0" aria-hidden />
        <div>
          <p className="text-[11px] font-semibold text-white">Sleep timer armed</p>
          <p className="text-[10px] text-white/50">Going offline in 2h 15m</p>
        </div>
      </div>
    </div>
  )
}

/* ---------- engine visual: placeholder bar ---------- */

function PlaceholderBar() {
  return (
    <div className="bg-[#0C0E14] border border-white/8 rounded-xl p-4">
      <div className="flex items-center gap-2 bg-white/[0.03] border border-white/10 rounded-lg px-3 py-2.5">
        <Sparkles className="w-3.5 h-3.5 text-violet-300 shrink-0" aria-hidden />
        <span className="text-[11px] text-white/55">What&rsquo;s happening around you?</span>
        <span className="ml-auto bg-violet-600 text-white text-[10px] font-semibold rounded-md px-2.5 py-1 shadow-[0_4px_14px_-4px_rgba(139,92,246,0.7)]">Preview</span>
      </div>
      <p className="mt-3 text-[10px] text-white/40">Live output</p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {['Bengaluru · 27°C', '9:41 PM', '3 friends live', 'Quest online'].map(c => (
          <span key={c} className="text-[10px] px-2 py-1 rounded-md bg-white/[0.04] border border-white/8 text-white/70">{c}</span>
        ))}
      </div>
    </div>
  )
}

/* ---------- FAQ item (accordion) ---------- */

function Faq({ q, a, delay }: { q: string; a: string; delay: number }) {
  const [open, setOpen] = useState(false)
  return (
    <Reveal delay={delay}>
      <div className="rounded-xl border border-white/5 bg-white/[0.02] overflow-hidden">
        <button
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          className="w-full flex items-center justify-between gap-4 text-left px-5 py-4 hover:bg-white/[0.02] transition-colors"
        >
          <span className="text-sm sm:text-base font-semibold text-white">{q}</span>
          <ChevronDown className={cn('w-4 h-4 shrink-0 text-white/60 transition-transform duration-300', open && 'rotate-180')} aria-hidden />
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

/* ---------- misc ---------- */

// Discord-style elapsed clock: "3:13" under an hour, "1:02:03" beyond.
function formatClock(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`
  return `${m}:${pad(s)}`
}
