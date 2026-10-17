// 10X RPC — /profile — the user's profile page.
// One page that answers "who am I, what's on my Discord right now, and what
// do I have set up?" — identity + live presence snapshot + setup stats +
// customization (background) + quick links + session/security.
// Read-only over the same APIs the dashboard uses (plus /api/background for
// the background setter) — it never writes RPC/game/rotation state, so it
// cannot drift any of the three RPC systems.
'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  Activity, ArrowLeft, Bot, Check, Copy, ExternalLink, Gamepad2, Gauge,
  Image as ImageIcon, Layers, LayoutDashboard, ListMusic, LogOut,
  Palette, RefreshCcw, ShieldCheck, Sparkles, Timer, TriangleAlert, UserRound,
} from 'lucide-react'
import { api, type Me, type GameListItem, type GameRotateSettings, type ApplicationRpcConfig } from '@/lib/api-client'
import { useRouter } from './useRouter'
import { Badge, Card, GhostButton, PrimaryButton, StatusGlyph, TextInput } from './ui'
import { BrandMark, BrandName } from './BrandMark'

const ME_REFRESH_MS = 20_000

// Activity type → the phrase Discord itself renders ("Playing", "Listening to…")
const TYPE_LABEL: Record<string, string> = {
  PLAYING: 'Playing',
  STREAMING: 'Streaming',
  LISTENING: 'Listening to',
  WATCHING: 'Watching',
  COMPETING: 'Competing in',
}
const typeLabel = (t?: string | null) => TYPE_LABEL[(t || 'PLAYING').toUpperCase()] || 'Playing'

const STATUS_LABEL: Record<string, string> = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'Do Not Disturb',
  invisible: 'Invisible',
  offline: 'Offline',
}
const PLATFORM_LABEL: Record<string, string> = {
  mobile: 'Mobile',
  desktop: 'None',
  meta_quest: 'VR',
}

function fmtDate(iso?: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  } catch { return '—' }
}

function memberSince(iso?: string | null): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '—'
  const days = Math.max(0, Math.floor((Date.now() - t) / 86_400_000))
  if (days < 1) return 'today'
  if (days < 31) return `${days} day${days === 1 ? '' : 's'} ago`
  const months = Math.floor(days / 30.44)
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`
  const years = Math.floor(months / 12)
  return `${years} year${years === 1 ? '' : 's'} ago`
}

function ago(iso?: string | null): string {
  if (!iso) return 'never'
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function fmtCountdown(totalSecs: number): string {
  const s = Math.max(0, Math.round(totalSecs))
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}:${String(s % 60).padStart(2, '0')}` : `${s}s`
}

function fmtInterval(secs: number): string {
  if (secs % 60 === 0) {
    const m = secs / 60
    return m === 1 ? '1 min' : `${m} min`
  }
  return `${secs}s`
}

export function ProfilePage() {
  const { navigate } = useRouter()

  // ── Session state ──
  const [me, setMe] = useState<Me | null>(null)
  const [meLoading, setMeLoading] = useState(true)
  const [meError, setMeError] = useState<string | null>(null)
  const [meFetchedAt, setMeFetchedAt] = useState(0)
  // 1s re-render pulse — every countdown / "X ago" label recomputes on render.
  const [, setTick] = useState(0)

  // ── Cross-system setup snapshot (each loads independently + resilient) ──
  const [games, setGames] = useState<GameListItem[] | null>(null)
  const [gameRotate, setGameRotate] = useState<GameRotateSettings | null>(null)
  const [appRpc, setAppRpc] = useState<ApplicationRpcConfig | null>(null)

  // ── Background editor ──
  const [bgDraft, setBgDraft] = useState('')
  const [bgSaving, setBgSaving] = useState(false)
  const [copied, setCopied] = useState<'id' | 'share' | null>(null)

  const refreshInFlight = useRef(false)
  const mounted = useRef(true)

  const loadMe = useCallback(async (manual = false) => {
    if (refreshInFlight.current) return
    if (manual) setMeLoading(true)
    refreshInFlight.current = true
    try {
      const m = await api.me()
      if (!mounted.current) return
      setMe(m)
      setMeFetchedAt(Date.now())
      setMeError(null)
      setBgDraft(m.user?.backgroundUrl || '')
    } catch (e) {
      if (!mounted.current) return
      setMe(prev => { if (!prev) setMeError(e instanceof Error ? e.message : 'Failed to load profile'); return prev })
    } finally {
      refreshInFlight.current = false
      if (mounted.current) setMeLoading(false)
    }
  }, [])

  const loadSetup = useCallback(async () => {
    // Each sub-resource loads independently — one failing endpoint must never
    // blank the whole profile.
    const [g, gr, ar] = await Promise.all([
      api.gamesList().then(r => r.games).catch(() => null),
      api.gamesRotateGet().then(r => r.gameRotate).catch(() => null),
      api.applicationRpcGet().then(r => r.config ?? null).catch(() => null),
    ])
    if (!mounted.current) return
    setGames(g)
    setGameRotate(gr)
    setAppRpc(ar)
  }, [])

  useEffect(() => {
    mounted.current = true
    loadMe(true)
    loadSetup()
    const meTimer = setInterval(() => loadMe(), ME_REFRESH_MS)
    const setupTimer = setInterval(loadSetup, 30_000)
    const tickTimer = setInterval(() => setTick(t => (t + 1) % 1_000_000), 1000)
    return () => {
      mounted.current = false
      clearInterval(meTimer); clearInterval(setupTimer); clearInterval(tickTimer)
    }
  }, [loadMe, loadSetup])

  const refreshAll = useCallback(async () => {
    await Promise.all([loadMe(), loadSetup()])
  }, [loadMe, loadSetup])

  const copyText = useCallback(async (text: string, kind: 'id' | 'share') => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(kind)
      setTimeout(() => setCopied(c => (c === kind ? null : c)), 1500)
      toast.success(kind === 'id' ? 'Discord ID copied' : 'Profile summary copied', { duration: 1800 })
    } catch {
      toast.error('Copy failed — clipboard unavailable')
    }
  }, [])

  const handleSaveBg = async () => {
    const trimmed = bgDraft.trim()
    if (trimmed && !/^https?:\/\//i.test(trimmed)) {
      toast.error('Background URL must start with http:// or https://')
      return
    }
    if (trimmed.length > 2048) {
      toast.error('URL too long (max 2048 chars)')
      return
    }
    setBgSaving(true)
    try {
      await api.background(trimmed || null)
      toast.success(trimmed ? 'Background updated' : 'Background cleared', { duration: 2000 })
      await loadMe()
    } catch {
      toast.error('Failed to save background')
    } finally {
      setBgSaving(false)
    }
  }

  const handleLogout = async () => {
    try {
      await api.logout()
    } catch { /* cookie may already be gone */ }
    window.location.href = '/'
  }

  // ════ Loading / error / auth gates (same pattern as the dashboard) ════
  if (meLoading && !me) return <ProfileSkeleton />

  if (meError && !me) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="glass-card p-6 max-w-md text-center">
          <p className="text-white font-medium mb-2"><TriangleAlert className="w-4 h-4 inline-block align-[-2px] mr-1 text-purple-300" />Something went wrong</p>
          <p className="text-sm text-white/60 mb-4">{meError}</p>
          <button onClick={() => { setMeError(null); loadMe(true) }} className="purple-gradient text-white font-medium px-4 py-2 rounded-xl">
            Try again
          </button>
        </div>
      </div>
    )
  }

  if (!me?.authenticated || !me.user) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="glass-card p-8 max-w-md text-center">
          <BrandMark className="w-14 h-14 rounded-2xl mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-white mb-2">Welcome to <BrandName /> RPC</h1>
          <p className="text-sm text-white/60 mb-6">Sign in with Discord to view your profile.</p>
          <div className="flex flex-col gap-2">
            <button onClick={() => { window.location.href = '/auth/discord' }} className="purple-gradient text-white font-semibold rounded-xl px-4 py-3 shadow-lg shadow-purple-900/30 hover:opacity-90 active:scale-[0.98] transition-all">
              Sign in with Discord
            </button>
            <button onClick={() => navigate({ name: 'home' })} className="inline-flex items-center gap-1 text-xs text-white/50 hover:text-white mt-2">
              <ArrowLeft className="w-3.5 h-3.5" /> Back to landing
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ════ Derived view models ════
  const u = me.user
  const s = me.session
  const sub = me.subscription
  const isAdminUser = !!me.isAdmin || !!sub?.admin
  const nowMs = Date.now()

  // Plan badge
  const planBadge = (() => {
    if (sub?.admin) return { text: 'ADMIN', cls: 'bg-amber-500/15 text-amber-300 border border-amber-500/30' }
    if (sub?.status === 'suspended') return { text: 'SUSPENDED', cls: 'bg-red-500/15 text-red-300 border border-red-500/30' }
    if (sub?.status === 'trialing') return { text: `FREE TRIAL · ${sub.daysLeft}D`, cls: 'bg-sky-500/15 text-sky-300 border border-sky-500/30' }
    if (sub?.neverExpires || sub?.plan === 'lifetime') return { text: 'LIFETIME', cls: 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30' }
    if (sub?.plan === 'pro') return { text: 'PRO', cls: 'bg-purple-500/15 text-purple-300 border border-purple-500/30' }
    if (sub?.plan === 'plus') return { text: 'PLUS', cls: 'bg-purple-500/15 text-purple-300 border border-purple-500/30' }
    return { text: 'FREE', cls: 'bg-white/10 text-white/70 border border-white/15' }
  })()

  const statusEnabled = s?.statusEnabled ?? false
  const statusValue = statusEnabled ? (s?.userStatus || 'online') : 'offline'
  // StatusGlyph has no 'offline' shape — Discord renders disabled presence as
  // the hollow gray (invisible) ring, so map offline → invisible for the glyph.
  const glyphStatus = statusEnabled ? statusValue : 'invisible'
  const platform = s?.statusPlatform || 'mobile'

  // Live presence ("what Discord shows right now") — mirrors dashboard truth
  const rotating = !!me.rotationPreview
  const liveLines: Array<{ icon: 'game' | 'rpc' | 'rotate' | 'app'; text: string; sub?: string }> = []
  if (rotating && me.rotationPreview) {
    const rp = me.rotationPreview
    const elapsed = meFetchedAt ? Math.max(0, Math.round((nowMs - meFetchedAt) / 1000)) : 0
    const nextIn = Math.max(0, rp.nextSwitchInSecs - elapsed)
    liveLines.push({
      icon: 'rotate',
      text: `Auto Rotate · ${rp.nowName}`,
      sub: `next: ${rp.nextName} in ${fmtCountdown(nextIn)} · pool of ${rp.pool.length}`,
    })
  } else if (me.activeRpcConfig) {
    liveLines.push({
      icon: me.activeRpcConfig.appId ? 'rpc' : 'rpc',
      text: `${typeLabel(me.activeRpcConfig.type)} ${me.activeRpcConfig.name}`,
      sub: me.activeRpcConfig.state || me.activeRpcConfig.details || undefined,
    })
  } else if (me.activeGames && me.activeGames.length > 0) {
    liveLines.push({
      icon: 'game',
      text: `Playing ${me.activeGames.map(g => g.name).join(', ')}`,
    })
  }
  if (appRpc?.enabled) {
    liveLines.push({
      icon: 'app',
      text: `App RPC · ${appRpc.name}`,
      sub: `${typeLabel(appRpc.type)} · ${appRpc.runState === 'running' ? 'running' : appRpc.runState === 'error' ? `error${appRpc.runError ? `: ${appRpc.runError}` : ''}` : appRpc.runState}`,
    })
  }
  if (s?.sleepTimerActive && s?.sleepTimerEndsAt) {
    liveLines.push({ icon: 'rpc', text: `Sleep timer active`, sub: `RPC goes offline at ${new Date(s.sleepTimerEndsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` })
  }

  // Setup stats
  const slots = me.rpcSlots || []
  const enabledSlots = slots.filter(x => x.enabled).length
  const gamesList = games || []
  const enabledGamesCount = gamesList.filter(g => g.enabled).length
  const rotatePool = gameRotate?.slots?.length ?? null
  const autoRotatePool = me.autoRotate?.slots?.length ?? null

  const shareText = [
    `${u.username}'s 10X RPC setup`,
    `Status: ${statusEnabled ? STATUS_LABEL[statusValue] : 'Offline'}${s?.customStatus ? ` — "${s.customStatus}"` : ''}`,
    liveLines.length ? `Live: ${liveLines.map(l => l.text).join(' · ')}` : 'Live: nothing (RPC off)',
    `Slots: ${enabledSlots}/${slots.length} enabled · Games: ${enabledGamesCount}/${gamesList.length} live`,
    `Rotations: RPC auto-rotate ${me.autoRotate?.enabled ? `on (${fmtInterval(me.autoRotate.secs)}, ${me.autoRotate.order})` : 'off'} · game rotation ${gameRotate?.enabled ? `on (${fmtInterval(gameRotate.secs)}, ${gameRotate.order})` : 'off'} · status rotator ${me.rotatorEnabled ? 'on' : 'off'} (${(me.rotatorPresets || []).length} presets)`,
  ].join('\n')

  const statTiles: Array<{ icon: React.ReactNode; label: string; value: string; sub: string; onClick: () => void; tint: string }> = [
    {
      icon: <Layers className="w-4 h-4" />, tint: 'text-purple-400',
      label: 'RPC Slots',
      value: `${enabledSlots} live`,
      sub: `${slots.length}/3 configured`,
      onClick: () => navigate({ name: 'dashboard' }),
    },
    {
      icon: <Gamepad2 className="w-4 h-4" />, tint: 'text-emerald-400',
      label: 'Game RPC',
      value: `${enabledGamesCount} live`,
      sub: `${gamesList.length} in library`,
      onClick: () => navigate({ name: 'games' }),
    },
    {
      icon: <RefreshCcw className="w-4 h-4" />, tint: 'text-fuchsia-400',
      label: 'Game Rotation',
      value: gameRotate ? (gameRotate.enabled ? 'On' : 'Off') : '—',
      sub: gameRotate?.enabled ? `${fmtInterval(gameRotate.secs)} · ${gameRotate.order}${rotatePool != null ? ` · ${rotatePool} picked` : ''}` : 'independent of RPC rotate',
      onClick: () => navigate({ name: 'games' }),
    },
    {
      icon: <RefreshCcw className="w-4 h-4" />, tint: 'text-sky-400',
      label: 'RPC Auto Rotate',
      value: me.autoRotate ? (me.autoRotate.enabled ? 'On' : 'Off') : '—',
      sub: me.autoRotate?.enabled ? `${fmtInterval(me.autoRotate.secs)} · ${me.autoRotate.order}${autoRotatePool != null ? ` · ${autoRotatePool} picked` : ''}` : 'slot rotation engine',
      onClick: () => navigate({ name: 'dashboard' }),
    },
    {
      icon: <ListMusic className="w-4 h-4" />, tint: 'text-amber-400',
      label: 'Status Rotator',
      value: String((me.rotatorPresets || []).length),
      sub: me.rotatorEnabled ? `rotating every ${me.globalConfig?.rotatorIntervalMins ?? 5} min` : 'presets saved',
      onClick: () => navigate({ name: 'rotator' }),
    },
    {
      icon: <Bot className="w-4 h-4" />, tint: 'text-violet-400',
      label: 'App RPC',
      value: appRpc ? (appRpc.enabled ? (appRpc.runState === 'running' ? 'Running' : appRpc.runState) : 'Saved') : 'Not set',
      sub: appRpc ? `${appRpc.name}${appRpc.appId ? ` · ${appRpc.appId}` : ''}` : 'own application identity',
      onClick: () => navigate({ name: 'dashboard' }),
    },
  ]

  return (
    <div className="min-h-screen flex flex-col">
      <div className="px-4 sm:px-6 py-6 max-w-2xl mx-auto w-full flex flex-col flex-1">
        {/* ── Header ── */}
        <header className="flex flex-wrap items-center justify-between gap-y-2 mb-6">
          <button onClick={() => navigate({ name: 'home' })} className="flex items-center gap-2" aria-label="10X RPC home">
            <BrandMark className="w-9 h-9" />
            <BrandName className="text-lg font-bold" suffix=" RPC" />
          </button>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {isAdminUser && (
              <button
                onClick={() => navigate({ name: 'admin' })}
                aria-label="Open admin dashboard"
                className="flex items-center gap-1.5 text-xs text-amber-200 hover:text-amber-100 bg-amber-500/10 border border-amber-500/30 px-3 py-1.5 rounded-lg hover:bg-amber-500/20 transition-all"
              >
                <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
                Admin
              </button>
            )}
            <GhostButton onClick={() => navigate({ name: 'dashboard' })} className="text-xs px-3 py-1.5">
              <span className="inline-flex items-center gap-1.5"><LayoutDashboard className="w-3.5 h-3.5" aria-hidden="true" /> Dashboard</span>
            </GhostButton>
          </div>
        </header>

        <main className="flex-1 space-y-6 pb-10">
          {/* ════ IDENTITY ════ */}
          <section aria-label="Profile identity">
            <Card className="relative overflow-hidden !p-0">
              {/* Background layer (user-configured) */}
              <div className="absolute inset-0 overflow-hidden pointer-events-none">
                <div className="absolute -top-16 -left-12 w-56 h-56 bg-purple-600/15 rounded-full blur-3xl" aria-hidden="true" />
                <div className="absolute -top-16 -right-12 w-48 h-48 bg-purple-900/10 rounded-full blur-2xl" aria-hidden="true" />
                {u.backgroundUrl && (
                  <>
                    <img src={u.backgroundUrl} alt="" className="absolute inset-0 w-full h-full object-cover opacity-25" />
                    <div className="absolute inset-0 bg-gradient-to-b from-[#0e0d14]/75 via-[#0e0d14]/90 to-[#0a0a0f]" />
                  </>
                )}
              </div>

              <div className="relative p-6 sm:p-7">
                <div className="flex flex-col sm:flex-row items-center sm:items-start gap-5">
                  {/* Avatar + status dot */}
                  <div className="relative shrink-0">
                    <img src={u.avatar} alt={`${u.username}'s avatar`} className="w-24 h-24 rounded-full object-cover border-2 border-white/10 shadow-2xl ring-1 ring-white/5" />
                    <span className="absolute bottom-0.5 right-1 w-5 h-5 rounded-full border-2 border-[#13111d] bg-[#181922] shadow-lg flex items-center justify-center">
                      <StatusGlyph status={glyphStatus} className="w-full h-full" />
                    </span>
                  </div>

                  <div className="min-w-0 flex-1 text-center sm:text-left">
                    <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
                      <h1 className="text-2xl font-black text-white truncate max-w-full">{u.username}</h1>
                      <Badge className={planBadge.cls}>{planBadge.text}</Badge>
                    </div>

                    {/* Discord ID + copy */}
                    <div className="mt-1.5 flex items-center justify-center sm:justify-start gap-1.5">
                      <code className="text-xs text-white/50 font-mono truncate">{u.id}</code>
                      <button
                        type="button"
                        onClick={() => copyText(u.id, 'id')}
                        aria-label="Copy Discord ID"
                        title="Copy Discord ID"
                        className="text-white/40 hover:text-purple-300 transition-colors"
                      >
                        {copied === 'id' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      </button>
                    </div>

                    <div className="mt-2.5 flex flex-wrap items-center justify-center sm:justify-start gap-x-4 gap-y-1 text-xs text-white/50">
                      <span className="inline-flex items-center gap-1.5">
                        <UserRound className="w-3.5 h-3.5 text-purple-400" aria-hidden="true" />
                        Member since {fmtDate(u.createdAt)} <span className="text-white/30">({memberSince(u.createdAt)})</span>
                      </span>
                      <span className="inline-flex items-center gap-1.5" title={s?.gatewayReady ? '24/7 gateway connected' : 'Gateway connecting…'}>
                        <span className={`w-2 h-2 rounded-full ${s?.gatewayReady ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'}`} aria-hidden="true" />
                        {s?.gatewayReady ? 'Gateway connected' : 'Gateway connecting…'}
                      </span>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center justify-center sm:justify-start gap-2">
                      <a
                        href={`https://discord.com/users/${u.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-xs text-[#c9cdff] hover:text-[#dfe2ff] bg-[#5865F2]/10 border border-[#5865F2]/30 px-3 py-1.5 rounded-lg hover:bg-[#5865F2]/20 transition-all"
                      >
                        <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                        Discord profile
                      </a>
                      <button
                        type="button"
                        onClick={() => copyText(shareText, 'share')}
                        className="inline-flex items-center gap-1.5 text-xs text-white/70 hover:text-white bg-white/5 border border-white/10 px-3 py-1.5 rounded-lg hover:bg-white/10 transition-all"
                      >
                        {copied === 'share' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
                        Copy setup summary
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </Card>
          </section>

          {/* ════ LIVE ON DISCORD ════ */}
          <section aria-label="Live presence">
            <Card>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-bold text-white flex items-center gap-2">
                  <Activity className="w-5 h-5 text-emerald-400" aria-hidden="true" /> Live on Discord
                </h2>
                <button onClick={() => refreshAll()} className="text-xs text-white/50 hover:text-white inline-flex items-center gap-1" aria-label="Refresh presence">
                  <RefreshCcw className="w-3.5 h-3.5" aria-hidden="true" /> Refresh
                </button>
              </div>

              {/* Status row */}
              <div className="flex flex-wrap items-center gap-2 mb-4">
                <Badge className="bg-white/5 border border-white/10 text-white">
                  <StatusGlyph status={glyphStatus} className="w-3 h-3" />
                  {STATUS_LABEL[statusValue] || 'Offline'}
                </Badge>
                <Badge className="bg-white/5 border border-white/10 text-white/80">
                  <Gauge className="w-3.5 h-3.5 text-white/50" aria-hidden="true" />
                  Badge: {PLATFORM_LABEL[platform] || platform}
                </Badge>
                {s?.vrStatusActive && (
                  <Badge className="bg-fuchsia-500/15 text-fuchsia-300 border border-fuchsia-500/30">VR active</Badge>
                )}
                {s?.customStatus && (
                  <Badge className="bg-white/5 border border-white/10 text-white/80 max-w-full">
                    <span className="truncate">{s.customStatusEmoji ? `${s.customStatusEmoji} ` : ''}{s.customStatus}</span>
                  </Badge>
                )}
              </div>

              {/* Live lines */}
              {liveLines.length === 0 ? (
                <p className="text-sm text-white/45">Nothing is live right now — turn on RPC from the dashboard to go live.</p>
              ) : (
                <ul className="space-y-2.5">
                  {liveLines.map((l, i) => (
                    <li key={i} className="flex items-start gap-3 rounded-xl bg-white/[0.04] border border-white/5 px-3.5 py-2.5">
                      <span className="mt-0.5 shrink-0" aria-hidden="true">
                        {l.icon === 'rotate' ? <RefreshCcw className="w-4 h-4 text-sky-400" />
                          : l.icon === 'game' ? <Gamepad2 className="w-4 h-4 text-emerald-400" />
                          : l.icon === 'app' ? <Bot className="w-4 h-4 text-violet-400" />
                          : <Sparkles className="w-4 h-4 text-purple-400" />}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-white truncate">{l.text}</span>
                        {l.sub && <span className="block text-xs text-white/45 truncate">{l.sub}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </section>

          {/* ════ SETUP STATS ════ */}
          <section aria-label="Setup stats">
            <h2 className="text-lg font-bold text-white mb-3 flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-purple-400" aria-hidden="true" /> Your setup
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {statTiles.map(t => (
                <button
                  key={t.label}
                  type="button"
                  onClick={t.onClick}
                  className="glass-card p-4 text-left hover:bg-white/[0.07] active:scale-[0.98] transition-all group"
                >
                  <div className={`flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-semibold ${t.tint}`}>
                    {t.icon}
                    <span className="truncate">{t.label}</span>
                  </div>
                  <div className="mt-1.5 text-xl font-bold text-white">{t.value}</div>
                  <div className="text-[11px] text-white/45 truncate">{t.sub}</div>
                </button>
              ))}
            </div>
          </section>

          {/* ════ CUSTOMIZATION — BACKGROUND ════ */}
          <section aria-label="Profile customization">
            <Card>
              <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                <Palette className="w-5 h-5 text-purple-400" aria-hidden="true" /> Customize
              </h2>

              <div className="space-y-1.5">
                <span className="text-[11px] uppercase tracking-wider text-purple-400 font-semibold">Profile card background</span>
                <p className="text-xs text-white/45">Shown behind your profile card on the dashboard and here. Paste any image URL.</p>
                <div className="flex gap-2 pt-1">
                  <TextInput
                    value={bgDraft}
                    onChange={e => setBgDraft(e.target.value)}
                    placeholder="https://example.com/background.jpg"
                    inputMode="url"
                    aria-label="Background image URL"
                    className="flex-1"
                  />
                  <PrimaryButton onClick={handleSaveBg} disabled={bgSaving} className="px-4 shrink-0">
                    {bgSaving ? 'Saving…' : 'Save'}
                  </PrimaryButton>
                  {u.backgroundUrl && (
                    <GhostButton
                      onClick={async () => { setBgDraft(''); try { await api.background(null); toast.success('Background cleared', { duration: 2000 }); await loadMe() } catch { toast.error('Failed to clear background') } }}
                      disabled={bgSaving}
                      className="px-3 shrink-0"
                      aria-label="Clear background"
                    >
                      Clear
                    </GhostButton>
                  )}
                </div>
                {u.backgroundUrl && (
                  <div className="mt-3 flex items-center gap-3 rounded-xl border border-white/8 bg-white/[0.03] p-3">
                    <img src={u.backgroundUrl} alt="Current background" className="w-20 h-12 object-cover rounded-lg border border-white/10" />
                    <div className="text-xs text-white/50 min-w-0">
                      <div className="flex items-center gap-1.5 text-white/70 font-medium"><ImageIcon className="w-3.5 h-3.5" aria-hidden="true" /> Background active</div>
                      <div className="truncate max-w-[16rem] sm:max-w-xs">{u.backgroundUrl}</div>
                    </div>
                  </div>
                )}
              </div>
            </Card>
          </section>

          {/* ════ QUICK LINKS ════ */}
          <section aria-label="Quick links">
            <h2 className="text-lg font-bold text-white mb-3 flex items-center gap-2">
              <Timer className="w-5 h-5 text-white/70" aria-hidden="true" /> Jump to
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {([
                { label: 'Dashboard', icon: <LayoutDashboard className="w-4 h-4 text-purple-400" />, route: { name: 'dashboard' } as const },
                { label: 'Game RPC', icon: <Gamepad2 className="w-4 h-4 text-emerald-400" />, route: { name: 'games' } as const },
                { label: 'Set Config', icon: <Gauge className="w-4 h-4 text-sky-400" />, route: { name: 'config' } as const },
                { label: 'Status Rotator', icon: <ListMusic className="w-4 h-4 text-amber-400" />, route: { name: 'rotator' } as const },
                { label: 'Uptime', icon: <Activity className="w-4 h-4 text-fuchsia-400" />, route: { name: 'uptime' } as const },
              ]).map(l => (
                <button
                  key={l.label}
                  type="button"
                  onClick={() => navigate(l.route)}
                  className="glass-card p-4 flex items-center gap-2.5 text-sm font-medium text-white/85 hover:bg-white/[0.07] active:scale-[0.98] transition-all"
                >
                  {l.icon}
                  <span className="truncate">{l.label}</span>
                </button>
              ))}
            </div>
          </section>

          {/* ════ SESSION & SECURITY ════ */}
          <section aria-label="Session and security">
            <Card>
              <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-emerald-400" aria-hidden="true" /> Session &amp; security
              </h2>
              <dl className="space-y-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-white/60">Discord OAuth</dt>
                  <dd className={s?.hasDiscordToken ? 'text-emerald-300 font-medium' : 'text-amber-300 font-medium'}>
                    {s?.hasDiscordToken ? 'Connected' : 'Not connected'}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-white/60">24/7 gateway</dt>
                  <dd className={s?.gatewayReady ? 'text-emerald-300 font-medium' : 'text-white/50 font-medium'}>
                    {s?.gatewayReady ? 'Ready' : 'Connecting…'}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-white/60">Last presence push</dt>
                  {/* tick re-renders keep the relative time fresh */}
                  <dd className="text-white/80 font-medium">{ago(s?.lastPresenceUpdate ?? null)}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-white/60">Access</dt>
                  <dd className="text-white/80 font-medium">
                    {sub?.admin ? 'Admin — full access'
                      : sub?.status === 'suspended' ? 'Suspended'
                      : sub?.status === 'trialing' ? `Free trial · ${sub.daysLeft} day${sub.daysLeft === 1 ? '' : 's'} left`
                      : sub?.neverExpires || sub?.plan === 'lifetime' ? 'Lifetime'
                      : sub ? `${sub.plan} · ${sub.daysLeft} day${sub.daysLeft === 1 ? '' : 's'} left`
                      : '—'}
                  </dd>
                </div>
              </dl>
              <div className="mt-5 pt-4 border-t border-white/5 flex items-center justify-between gap-3">
                <p className="text-xs text-white/40">Logging out ends this browser session — your RPC keeps running on the 24/7 nodes.</p>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-red-300 hover:text-red-200 bg-red-500/10 border border-red-500/25 px-3 py-2 rounded-xl hover:bg-red-500/20 transition-all shrink-0"
                >
                  <LogOut className="w-3.5 h-3.5" aria-hidden="true" /> Logout
                </button>
              </div>
            </Card>
          </section>
        </main>

        {/* ── Sticky footer (mt-auto keeps it pinned on short screens) ── */}
        <footer className="mt-auto pt-2 pb-4 text-center">
          <p className="text-[11px] text-white/30">10X RPC · profile — your presence, at a glance.</p>
        </footer>
      </div>
    </div>
  )
}

// ── Loading skeleton ──
function ProfileSkeleton() {
  return (
    <div className="min-h-screen px-4 sm:px-6 py-6 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <BrandMark className="w-9 h-9" />
          <BrandName className="text-lg font-bold" suffix=" RPC" />
        </div>
        <div className="h-8 w-24 rounded-xl bg-white/5 animate-pulse" />
      </div>
      <div className="space-y-6">
        <div className="glass-card p-6 flex items-center gap-5">
          <div className="w-24 h-24 rounded-full bg-white/5 animate-pulse shrink-0" />
          <div className="flex-1 space-y-3">
            <div className="h-6 w-40 rounded bg-white/5 animate-pulse" />
            <div className="h-3.5 w-32 rounded bg-white/5 animate-pulse" />
            <div className="h-3.5 w-48 rounded bg-white/5 animate-pulse" />
          </div>
        </div>
        <div className="glass-card p-6 space-y-3">
          <div className="h-5 w-36 rounded bg-white/5 animate-pulse" />
          <div className="h-14 rounded-xl bg-white/5 animate-pulse" />
          <div className="h-14 rounded-xl bg-white/5 animate-pulse" />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {[0, 1, 2, 3, 4, 5].map(i => <div key={i} className="glass-card p-4 h-24 animate-pulse" />)}
        </div>
      </div>
    </div>
  )
}
