// 10X RPC — Admin dashboard page (/admin)
// MENU (tabs): Overview · Plans · Users · Payments · Trials · Analytics ·
//              Sessions · Control · Audit · Settings
//   Overview  — System Health (live probes), platform stats, 7-day signup
//               trend, newest users.
//   Plans     — plan catalog CRUD (price/duration/features/visibility) that
//               powers the pricing page + checkout.
//   Users     — subscription management (server-side search / filters /
//               sorting / pagination) → per-user subscription modal.
//   Payments  — Razorpay ledger: revenue summary, plan split, latest
//               payments, filter + CSV export.
//   Trials    — trial policy (DB-backed) + live trial roster.
//   Analytics — subscription analytics from the live DB (conversion, plan
//               popularity, revenue, 14-day trends).
//   Sessions  — Session monitor (active/expired, live flags, per-session
//               revoke, purge expired).
//   Control   — 24/7 RPC global control + maintenance.
//   Audit     — tamper-resistant log of every privileged admin action.
//   Settings  — Non-secret platform settings + copy debug report.
// Access: Discord IDs in ADMIN_DISCORD_IDS only — every /api/admin/* endpoint
// re-checks server-side, this UI is just the window.
'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import { toast } from 'sonner'
import {
  api,
  type AdminStats,
  type AdminSessionRow,
  type AdminSessionAction,
  type AdminSettings,
  type AdminPaymentRow,
  type AdminPaymentsResponse,
} from '@/lib/api-client'
import { useRouter } from './useRouter'
import { Card, PrimaryButton, GhostButton, BackButton, Badge } from './ui'
import { Lock, Download, Trash2, KeyRound, Check, X, Glasses, MoonStar, TriangleAlert, MessageCircle, Smartphone, RefreshCw } from 'lucide-react'
import { PlansTab } from './admin/PlansTab'
import { UsersTab } from './admin/UsersTab'
import { TrialsTab } from './admin/TrialsTab'
import { AnalyticsTab } from './admin/AnalyticsTab'
import { AuditTab } from './admin/AuditTab'

type AdminTab = 'overview' | 'plans' | 'users' | 'payments' | 'trials' | 'analytics' | 'sessions' | 'control' | 'audit' | 'settings'

type PaymentsFilter = 'all' | 'paid' | 'created'

const TABS: { id: AdminTab; label: string; icon: React.ReactNode }[] = [
  { id: 'overview', label: 'Overview', icon: <IconGrid /> },
  { id: 'plans', label: 'Plans', icon: <IconTag /> },
  { id: 'users', label: 'Users', icon: <IconUsers /> },
  { id: 'payments', label: 'Payments', icon: <IconCoin /> },
  { id: 'trials', label: 'Trials', icon: <IconClock /> },
  { id: 'analytics', label: 'Analytics', icon: <IconChart /> },
  { id: 'sessions', label: 'Sessions', icon: <IconClock /> },
  { id: 'control', label: 'Control', icon: <IconPower /> },
  { id: 'audit', label: 'Audit', icon: <IconShield /> },
  { id: 'settings', label: 'Settings', icon: <IconGear /> },
]

export function AdminPage() {
  const { navigate } = useRouter()
  const [tab, setTab] = useState<AdminTab>('overview')
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [settings, setSettings] = useState<AdminSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  // Sessions tab
  const [sessionsScope, setSessionsScope] = useState<'active' | 'expired'>('active')
  const [sessions, setSessions] = useState<AdminSessionRow[]>([])
  const [sessionSummary, setSessionSummary] = useState<AdminSessionsSummary | null>(null)
  const [sessionsLoading, setSessionsLoading] = useState(false)
  // Payments tab
  const [payments, setPayments] = useState<AdminPaymentRow[]>([])
  const [paymentsSummary, setPaymentsSummary] = useState<AdminPaymentsResponse['summary'] | null>(null)
  const [paymentsLoading, setPaymentsLoading] = useState(false)
  const [paymentsFilter, setPaymentsFilter] = useState<PaymentsFilter>('all')
  const tabRef = useRef<AdminTab>('overview')
  tabRef.current = tab

  // Restore the last opened tab (default Overview).
  useEffect(() => {
    const saved = localStorage.getItem('10x-admin-tab')
    if (saved && TABS.some(t => t.id === saved)) setTab(saved as AdminTab)
  }, [])
  useEffect(() => {
    localStorage.setItem('10x-admin-tab', tab)
  }, [tab])

  const refresh = useCallback(async () => {
    try {
      // stats/settings are best-effort; the heavy tabs load on demand.
      const [statsRes, settingsRes] = await Promise.all([
        api.adminStats().catch(() => null),
        api.adminSettings().catch(() => null),
      ])
      setStats(statsRes)
      setSettings(settingsRes)
      setError(null)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load'
      const denied = msg.includes('forbidden') || msg.toLowerCase().includes('admin access required')
      if (denied) {
        setError('You are not an admin. Your Discord ID is not in the admin list.')
      } else if (msg.includes('not_authenticated')) {
        setError('Please sign in first.')
      } else {
        setError(msg)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  const loadSessions = useCallback(async (scope: 'active' | 'expired') => {
    setSessionsLoading(true)
    try {
      const res = await api.adminSessions(scope)
      if (tabRef.current === 'sessions') {
        setSessions(res.sessions)
        setSessionSummary(res.summary)
      }
    } catch {
      if (tabRef.current === 'sessions') setSessions([])
    } finally {
      setSessionsLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 30000) // auto-refresh every 30s
    return () => clearInterval(t)
  }, [refresh])

  // Load sessions whenever the Sessions tab is opened or the scope changes.
  useEffect(() => {
    if (tab === 'sessions') loadSessions(sessionsScope)
  }, [tab, sessionsScope, loadSessions])

  const loadPayments = useCallback(async () => {
    setPaymentsLoading(true)
    try {
      const res = await api.adminPayments()
      if (tabRef.current === 'payments') {
        setPayments(res.payments)
        setPaymentsSummary(res.summary)
      }
    } catch {
      if (tabRef.current === 'payments') setPayments([])
    } finally {
      setPaymentsLoading(false)
    }
  }, [])

  // Load payments whenever the Payments tab is opened.
  useEffect(() => {
    if (tab === 'payments') loadPayments()
  }, [tab, loadPayments])

  const handleForceEnable = async () => {
    setBusy(true)
    try {
      const r = await api.adminForceRpc(true)
      toast.success(`RPC force-enabled for ${r.successCount}/${r.totalUsers} users`, { duration: 4000 })
      refresh()
    } catch {
      toast.error('Failed to force-enable RPC')
    } finally {
      setBusy(false)
    }
  }

  const handleForceDisable = async () => {
    setBusy(true)
    try {
      const r = await api.adminForceRpc(false)
      toast.success(`RPC force-disabled for ${r.successCount}/${r.totalUsers} users`, { duration: 4000 })
      refresh()
    } catch {
      toast.error('Failed to force-disable RPC')
    } finally {
      setBusy(false)
    }
  }

  const handleKeepAlive = async () => {
    setBusy(true)
    try {
      const r = await api.keepAlive()
      toast.success(`Keep-alive: ${r.successCount}/${r.totalActive} refreshed`, { duration: 4000 })
      refresh()
    } catch {
      toast.error('Keep-alive failed')
    } finally {
      setBusy(false)
    }
  }

  const runSessionAction = async (action: AdminSessionAction, sessionId?: string, confirmMsg?: string) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return
    const key = `sess:${action}:${sessionId ?? 'all'}`
    setActionBusy(key)
    try {
      const r = await api.adminSessionAction(action, sessionId)
      if (r.ok) toast.success(r.message, { duration: 4000 })
      else toast.error(r.message, { duration: 5000 })
      loadSessions(sessionsScope)
      refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setActionBusy(null)
    }
  }

  const exportPaymentsCsv = () => {
    const head = ['createdAt', 'username', 'discordId', 'plan', 'amountPaise', 'amountRupees', 'currency', 'status', 'orderId', 'paymentId']
    const esc = (v: unknown) => `"${String(v).replace(/"/g, '""')}"`
    const rows = payments.map(p => [
      p.createdAt, p.username, p.discordId, p.plan,
      p.amount, (p.amount / 100).toFixed(2), p.currency, p.status,
      p.orderId, p.paymentId ?? '',
    ].map(esc).join(','))
    const csv = [head.map(esc).join(','), ...rows].join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    a.download = `10x-payments-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
    toast.success(`Exported ${payments.length} payments to CSV`)
  }

  const copyReport = async () => {
    const sys = stats?.system
    const c = stats?.counts
    const lines = [
      `10X RPC Admin Debug Report — ${new Date().toISOString()}`,
      `Region: ${settings?.infra.serverRegion ?? '?'} | Env: ${settings?.app.nodeEnv ?? '?'}`,
      `System: ${sys ? (sys.operational ? 'Operational' : sys.degraded ? 'Degraded' : 'Outage') : 'unavailable'}`,
      `Probes: DB ${sys?.database.latencyMs ?? '?'}ms · Discord ${sys?.discord.latencyMs ?? '?'}ms · Daemon ${sys?.daemon.latencyMs ?? '?'}ms`,
      `Daemon: uptime ${fmtUptime(sys?.daemon.daemonUptimeSeconds)} · connections ${sys?.daemon.activeConnections ?? '?'} · tracked ${sys?.daemon.totalTrackedUsers ?? '?'}`,
      `Users: ${c?.totalUsers ?? '?'} · RPC live ${c?.rpcLive ?? '?'} · tokens ${c?.sessionsWithToken ?? '?'} · sessions ${c?.activeSessions ?? '?'}`,
      `UA: ${navigator.userAgent}`,
    ]
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      toast.success('Debug report copied to clipboard')
    } catch {
      toast.error('Clipboard unavailable')
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block w-10 h-10 rounded-full border-2 border-purple-500/30 border-t-purple-500 animate-spin mb-3" />
          <p className="text-white/60 text-sm">Loading admin dashboard...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen px-4 py-6 max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <BackButton onClick={() => navigate({ name: 'dashboard' })} />
          <h1 className="text-2xl font-bold text-white">Admin</h1>
          <div className="w-16" />
        </div>
        <Card>
          <div className="text-center space-y-3 py-8">
            <Lock className="w-10 h-10 mx-auto text-white/50" />
            <p className="text-white/70 font-medium">Access Denied</p>
            <p className="text-sm text-white/50 max-w-xs mx-auto">{error}</p>
          </div>
        </Card>
      </div>
    )
  }

  const c = stats?.counts
  const sys = stats?.system

  const tabBadge = (id: AdminTab): string | null => {
    if (id === 'users' && c) return String(c.totalUsers)
    if (id === 'payments' && c) return String(c.paymentsPaid)
    if (id === 'sessions' && c) return String(c.activeSessions)
    return null
  }

  return (
    <div className="min-h-screen max-w-3xl mx-auto pb-12">
      {/* Header */}
      <div className="px-4 sm:px-6 pt-6 flex items-center justify-between mb-4">
        <BackButton onClick={() => navigate({ name: 'dashboard' })} />
        <h1 className="text-2xl font-bold text-white">Admin Dashboard</h1>
        <button
          onClick={refresh}
          aria-label="Refresh data"
          className="inline-flex items-center gap-1.5 text-xs text-white/60 hover:text-white bg-white/5 border border-white/10 px-3 py-1.5 rounded-lg hover:bg-white/10 transition-all"
        >
          <RefreshCw className="w-3 h-3" />
          Refresh
        </button>
      </div>

      {/* Menu (tabs) — sticky, horizontally scrollable on mobile */}
      <nav
        aria-label="Admin sections"
        className="sticky top-0 z-20 bg-[#0a0a0f]/85 backdrop-blur-md border-b border-white/10 mb-4"
      >
        <div className="px-4 sm:px-6 flex gap-1 overflow-x-auto styled-scroll" role="tablist">
          {TABS.map(t => {
            const active = tab === t.id
            const badge = tabBadge(t.id)
            return (
              <button
                key={t.id}
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.id)}
                className={`relative shrink-0 flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium border-b-2 transition-all ${
                  active
                    ? 'border-purple-400 text-white'
                    : 'border-transparent text-white/45 hover:text-white/80'
                }`}
              >
                <span className={active ? 'text-white/90' : ''}>{t.icon}</span>
                {t.label}
                {badge && (
                  <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${active ? 'bg-purple-500/30 text-white/90' : 'bg-white/10 text-white/50'}`}>
                    {badge}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </nav>

      <div className="px-4 sm:px-6">
        {tab === 'overview' && (
          <OverviewTab sys={sys} stats={stats} c={c} />
        )}

        {tab === 'plans' && <PlansTab />}

        {tab === 'users' && <UsersTab />}

        {tab === 'payments' && (() => {
          const ps = paymentsSummary
          const filteredPayments = paymentsFilter === 'all' ? payments : payments.filter(p => p.status === paymentsFilter)
          return (
            <div className="space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <StatCard label="Revenue ₹" value={ps ? Math.round(ps.revenueTotalPaise / 100) : 0} color="text-amber-300" />
                <StatCard label="Revenue 30d ₹" value={ps ? Math.round(ps.revenue30dPaise / 100) : 0} color="text-emerald-400" />
                <StatCard label="Paid" value={ps?.paidCount ?? 0} color="text-red-400" />
                <StatCard label="Paying users" value={ps?.payingUsers ?? 0} color="text-sky-400" />
              </div>

              <Card>
                <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
                  <h3 className="font-bold text-white">Payment Ledger</h3>
                  <div className="flex items-center gap-2">
                    <div className="flex bg-white/5 border border-white/10 rounded-lg overflow-hidden">
                      {(['all', 'paid', 'created'] as PaymentsFilter[]).map(f => (
                        <button
                          key={f}
                          onClick={() => setPaymentsFilter(f)}
                          className={`text-[11px] px-3 py-1.5 capitalize transition-all ${paymentsFilter === f ? 'bg-purple-500/25 text-white/90' : 'text-white/50 hover:text-white/80'}`}
                        >
                          {f}
                        </button>
                      ))}
                    </div>
                    <button
                      onClick={exportPaymentsCsv}
                      className="text-[11px] text-white/90 bg-emerald-500/10 border border-emerald-500/30 px-2.5 py-1 rounded-lg hover:bg-emerald-500/20 transition-all inline-flex items-center gap-1"
                    >
                      <Download className="w-3 h-3" />Export CSV
                    </button>
                  </div>
                </div>

                {ps && (
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-white/50 mb-3">
                    <span>Plus sold: <b className="text-white/80">{ps.plusPaid}</b></span>
                    <span>Pro sold: <b className="text-white/80">{ps.proPaid}</b></span>
                    <span>Paid 30d: <b className="text-white/80">{ps.paid30dCount}</b></span>
                    <span>Abandoned checkouts: <b className="text-white/80">{ps.createdCount}</b></span>
                  </div>
                )}

                <div className="space-y-2 max-h-[60vh] overflow-y-auto styled-scroll">
                  {paymentsLoading && payments.length === 0 ? (
                    <p className="text-sm text-white/40 text-center py-6">Loading payments…</p>
                  ) : filteredPayments.length === 0 ? (
                    <p className="text-sm text-white/40 text-center py-6">
                      {payments.length === 0
                        ? 'No payments yet — rows appear here after the first Razorpay checkout.'
                        : 'No payments with this filter.'}
                    </p>
                  ) : (
                    filteredPayments.map(p => <PaymentRow key={p.id} payment={p} />)
                  )}
                </div>
              </Card>
            </div>
          )
        })()}

        {tab === 'trials' && <TrialsTab />}

        {tab === 'analytics' && <AnalyticsTab />}

        {tab === 'sessions' && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              <StatCard label="Active" value={sessionSummary?.activeCount ?? c?.activeSessions ?? 0} color="text-green-400" />
              <StatCard label="Expiring 24h" value={sessionSummary?.expiringSoon24h ?? 0} color="text-amber-300" />
              <StatCard label="With Token" value={sessionSummary?.withTokenActive ?? c?.sessionsWithToken ?? 0} color="text-sky-400" />
              <StatCard label="RPC Live" value={sessionSummary?.rpcLiveActive ?? c?.rpcLive ?? 0} color="text-green-400" />
              <StatCard label="Expired" value={sessionSummary?.expiredCount ?? 0} color="text-white/60" />
            </div>

            <Card>
              <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
                <h3 className="font-bold text-white">Session Monitor</h3>
                <div className="flex items-center gap-2">
                  <div className="flex bg-white/5 border border-white/10 rounded-lg overflow-hidden">
                    <button
                      onClick={() => setSessionsScope('active')}
                      className={`text-[11px] px-3 py-1.5 transition-all ${sessionsScope === 'active' ? 'bg-purple-500/25 text-white/90' : 'text-white/50 hover:text-white/80'}`}
                    >
                      Active
                    </button>
                    <button
                      onClick={() => setSessionsScope('expired')}
                      className={`text-[11px] px-3 py-1.5 transition-all ${sessionsScope === 'expired' ? 'bg-purple-500/25 text-white/90' : 'text-white/50 hover:text-white/80'}`}
                    >
                      Expired
                    </button>
                  </div>
                  <button
                    onClick={() => runSessionAction('purge-expired', undefined, 'Delete ALL expired sessions from the database?')}
                    className="text-[11px] text-white/90 bg-red-500/10 border border-red-500/30 px-2.5 py-1 rounded-lg hover:bg-red-500/20 transition-all inline-flex items-center gap-1"
                  >
                    <Trash2 className="w-3 h-3" />Purge Expired
                  </button>
                </div>
              </div>

              <div className="space-y-2 max-h-[60vh] overflow-y-auto styled-scroll">
                {sessionsLoading && sessions.length === 0 ? (
                  <p className="text-sm text-white/40 text-center py-6">Loading sessions…</p>
                ) : sessions.length === 0 ? (
                  <p className="text-sm text-white/40 text-center py-6">
                    {sessionsScope === 'active' ? 'No active sessions.' : 'No expired sessions (clean!).'}
                  </p>
                ) : (
                  sessions.map(s => (
                    <SessionRow
                      key={s.id}
                      session={s}
                      busy={actionBusy === `sess:revoke:${s.id}`}
                      onRevoke={() => runSessionAction(
                        'revoke',
                        s.id,
                        s.isSelf
                          ? `Revoke YOUR OTHER session (${s.username})? That device will be logged out.`
                          : `Revoke this session for ${s.username}? That device will be logged out.`,
                      )}
                    />
                  ))
                )}
              </div>
            </Card>
          </div>
        )}

        {tab === 'control' && (
          <div className="space-y-4">
            <Card>
              <h3 className="font-bold text-white mb-3">24/7 RPC Control</h3>
              <div className="grid grid-cols-3 gap-2">
                <PrimaryButton onClick={handleForceEnable} disabled={busy} className="text-xs">
                  {busy ? '...' : 'Force Enable All'}
                </PrimaryButton>
                <GhostButton onClick={handleKeepAlive} disabled={busy} className="text-xs">
                  {busy ? '...' : 'Keep-Alive Now'}
                </GhostButton>
                <GhostButton onClick={handleForceDisable} disabled={busy} className="text-xs text-white">
                  {busy ? '...' : 'Disable All'}
                </GhostButton>
              </div>
              <p className="text-xs text-white/40 mt-3">
                Force Enable: pushes RPC + status + VR icon for all users with Discord tokens.
                Keep-Alive: refreshes presence for all active users (call every 5 min for 24/7).
              </p>
            </Card>

            <Card>
              <h3 className="font-bold text-white mb-1">Maintenance</h3>
              <p className="text-xs text-white/40 mb-3">Database hygiene — safe to run anytime.</p>
              <div className="grid sm:grid-cols-2 gap-2">
                <GhostButton
                  onClick={() => runSessionAction('purge-expired', undefined, 'Delete ALL expired sessions from the database?')}
                  disabled={actionBusy === 'sess:purge-expired:all'}
                  className="text-xs justify-center"
                >
                  {actionBusy === 'sess:purge-expired:all' ? '…' : <span className="inline-flex items-center justify-center gap-1.5"><Trash2 className="w-3.5 h-3.5" />Purge Expired Sessions</span>}
                </GhostButton>
                <GhostButton
                  onClick={() => runSessionAction('purge-oauth', undefined, 'Delete ALL expired OAuth state rows?')}
                  disabled={actionBusy === 'sess:purge-oauth:all'}
                  className="text-xs justify-center"
                >
                  {actionBusy === 'sess:purge-oauth:all' ? '…' : <span className="inline-flex items-center justify-center gap-1.5"><KeyRound className="w-3.5 h-3.5" />Clean OAuth States{c ? ` (${c.oauthStates} live)` : ''}</span>}
                </GhostButton>
              </div>
            </Card>
          </div>
        )}

        {tab === 'audit' && <AuditTab />}

        {tab === 'settings' && (
          <div className="space-y-4">
            <Card>
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-bold text-white">Platform Settings</h3>
                <button
                  onClick={copyReport}
                  className="text-[11px] text-white/90 bg-purple-500/10 border border-purple-500/30 px-2.5 py-1 rounded-lg hover:bg-purple-500/20 transition-all"
                >
                  ⧉ Copy Debug Report
                </button>
              </div>
              {settings ? (
                <div className="space-y-4 text-sm">
                  <SettingsGroup title="App">
                    <SettingRow label="Name" value={settings.app.name} />
                    <SettingRow label="App URL" value={settings.app.url} mono />
                    <SettingRow label="Free trial" value={`${settings.app.trialDays} days`} />
                    <SettingRow label="Session TTL" value={`${settings.app.sessionTtlDays} days`} />
                    <SettingRow label="Environment" value={settings.app.nodeEnv} />
                  </SettingsGroup>
                  <SettingsGroup title="Discord">
                    <SettingRow label="Client ID" value={settings.discord.clientId} mono />
                    <SettingRow label="OAuth scope" value={settings.discord.oauthScope} mono />
                    <SettingRow label="Auto-join guild" value={settings.discord.autoJoinGuildId ?? '—'} mono />
                    <SettingRow label="Invite" value={settings.discord.inviteUrl} link />
                    <SettingRow label="Bot token" value={settings.discord.botConfigured ? 'configured' : 'missing'} ok={settings.discord.botConfigured} />
                    <SettingRow label="OAuth secret" value={settings.discord.oauthConfigured ? 'configured' : 'missing'} ok={settings.discord.oauthConfigured} />
                  </SettingsGroup>
                  <SettingsGroup title="Infrastructure">
                    <SettingRow label="Server region" value={settings.infra.serverRegion} />
                    <SettingRow label="24/7 daemon" value={settings.infra.daemonConfigured ? `${settings.infra.daemonHost ?? 'configured'}` : 'not configured'} ok={settings.infra.daemonConfigured} />
                    <SettingRow label="Panel host" value={settings.infra.panelConfigured ? `${settings.infra.panelHost ?? 'configured'}` : 'not configured'} ok={settings.infra.panelConfigured} />
                  </SettingsGroup>
                  <SettingsGroup title="Payments">
                    <SettingRow label="Razorpay" value={settings.payments.razorpayConfigured ? 'configured' : 'keys missing — checkout disabled'} ok={settings.payments.razorpayConfigured} />
                    <SettingRow label="Webhook secret" value={settings.payments.webhookConfigured ? 'configured' : 'missing'} ok={settings.payments.webhookConfigured} />
                    <SettingRow label="Webhook path" value={settings.payments.webhookPath} mono />
                    <SettingRow label="Currency" value={settings.payments.currency} />
                    {settings.payments.plans.map(p => (
                      <SettingRow key={p.id} label={`${p.label} plan`} value={`${p.display} / ${p.periodDays}d (${p.amount} paise)`} />
                    ))}
                  </SettingsGroup>
                  <SettingsGroup title={`Admins (${settings.admin.adminCount})`}>
                    {settings.admin.adminDiscordIds.map(id => (
                      <SettingRow
                        key={id}
                        label={id === settings.admin.yourDiscordId ? 'You' : 'Admin'}
                        value={id}
                        mono
                      />
                    ))}
                  </SettingsGroup>
                </div>
              ) : (
                <p className="text-xs text-white/40">Settings unavailable — refresh to retry.</p>
              )}
            </Card>

            <Card>
              <h3 className="font-bold text-white mb-2">Access Model</h3>
              <p className="text-xs text-white/50 leading-relaxed">
                Admin access is granted by Discord ID (<span className="font-mono">ADMIN_DISCORD_IDS</span>).
                Every admin API endpoint re-verifies the session server-side — this dashboard is only
                the window. Subscriptions: every account starts with a {settings?.app.trialDays ?? 3}-day free trial;
                when it (or a paid period) ends the account is SUSPENDED — 24/7 RPC stops until you grant
                days (Users tab → Manage), reset the trial, or give lifetime. Plans, prices, durations and
                the trial policy are managed from the Plans / Trials tabs and served from the database.
                Admins bypass gating. All privileged actions land in the Audit tab with the reason.
              </p>
            </Card>
          </div>
        )}
      </div>
    </div>
  )
}

interface AdminSessionsSummary {
  activeCount: number
  expiredCount: number
  expiringSoon24h: number
  withTokenActive: number
  rpcLiveActive: number
}

function OverviewTab({ sys, stats, c }: { sys: AdminStats['system'] | undefined; stats: AdminStats | null; c: AdminStats['counts'] | undefined }) {
  const trend = stats?.signupTrend ?? []
  const newest = stats?.newestUsers ?? []
  const maxCount = Math.max(...trend.map(p => p.count), 1)
  return (
    <div className="space-y-4">
      {/* System health */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold text-white">System Health</h3>
          {sys && <SystemBadge operational={sys.operational} degraded={sys.degraded} />}
        </div>
        {sys ? (
          <div className="space-y-1">
            <ProbeRow label="Database" ok={sys.database.ok} latencyMs={sys.database.latencyMs} />
            <ProbeRow label="Discord API" ok={sys.discord.ok} latencyMs={sys.discord.latencyMs} />
            <ProbeRow
              label="24/7 Daemon"
              ok={sys.daemon.ok}
              latencyMs={sys.daemon.latencyMs}
              note={!sys.daemon.configured ? 'not configured' : sys.daemon.running === false ? 'not running' : undefined}
            />
            {(sys.daemon.configured) && (
              <div className="flex flex-wrap gap-x-4 gap-y-1 pt-2 mt-1 border-t border-white/5 text-[11px] text-white/40">
                <span>Tracked users: <span className="text-white/70">{sys.daemon.totalTrackedUsers ?? '—'}</span></span>
                <span>Active connections: <span className="text-white/70">{sys.daemon.activeConnections ?? '—'}</span></span>
                <span>Daemon uptime: <span className="text-white/70">{fmtUptime(sys.daemon.daemonUptimeSeconds)}</span></span>
                <span>Region: <span className="text-white/70">{sys.serverRegion}</span></span>
              </div>
            )}
          </div>
        ) : (
          <p className="text-xs text-white/40">System health unavailable (stats endpoint failed) — user data still loaded.</p>
        )}
      </Card>

      {/* Platform stats */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
        <StatCard label="Users" value={c ? c.totalUsers : 0} color="text-red-300" />
        <StatCard label="RPC Live" value={c?.rpcLive ?? 0} color="text-green-400" />
        <StatCard label="With Token" value={c?.sessionsWithToken ?? 0} color="text-sky-400" />
        <StatCard label="Status On" value={c?.statusEnabled ?? 0} color="text-red-400" />
        <StatCard label="VR Active" value={c?.vrActive ?? 0} color="text-cyan-300" />
        <StatCard label="New 24h" value={c?.newUsers24h ?? 0} color="text-amber-300" />
      </div>

      {/* 7-day signup trend */}
      {trend.length > 0 && (
        <Card>
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-bold text-white">Signups — last 7 days</h3>
            <span className="text-xs text-white/40">total {trend.reduce((a, p) => a + p.count, 0)}</span>
          </div>
          <div className="flex items-end gap-2 h-24">
            {trend.map(p => (
              <div key={p.date} className="flex-1 flex flex-col items-center justify-end h-full gap-1" title={`${p.date}: ${p.count}`}>
                <span className={`text-[10px] ${p.count > 0 ? 'text-white/90' : 'text-white/30'}`}>{p.count}</span>
                <div
                  className={`w-full rounded-t-md transition-all ${p.count > 0 ? 'bg-gradient-to-t from-purple-600/60 to-purple-400/80' : 'bg-white/5'}`}
                  style={{ height: `${p.count > 0 ? Math.max(8, (p.count / maxCount) * 100) : 4}%` }}
                />
                <span className="text-[9px] text-white/35 uppercase">{new Date(p.date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short' })}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Newest users */}
      {newest.length > 0 && (
        <Card>
          <h3 className="font-bold text-white mb-3">Newest Users</h3>
          <div className="space-y-2">
            {newest.map(u => (
              <div key={u.id} className="flex items-center gap-3">
                <div className="w-7 h-7 rounded-full bg-purple-500/20 border border-purple-500/30 flex items-center justify-center text-white/90 text-xs font-bold shrink-0">
                  {u.username.charAt(0).toUpperCase()}
                </div>
                <span className="text-sm text-white/85 truncate flex-1">{u.username}</span>
                <span className="text-xs text-white/35 shrink-0">{fmtRel(u.createdAt)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Secondary counters */}
      {c && (
        <div className="flex flex-wrap gap-1.5">
          <MiniChip label="Active sessions" value={c.activeSessions} />
          <MiniChip label="Sleep timers" value={c.sleepTimersActive} />
          <MiniChip label="Games live" value={c.gamesEnabled} />
          <MiniChip label="Custom games" value={c.customGames} />
          <MiniChip label="Rotator users" value={c.rotatorEnabledUsers} />
          <MiniChip label="Presets" value={c.rotatorPresets} />
          <MiniChip label="Favorites" value={c.favorites} />
          <MiniChip label="Trials active (legacy)" value={c.trialsActive} />
          <MiniChip label="Subs active" value={c.subsActive} />
          <MiniChip label="Subs trialing" value={c.subsTrialing} />
          <MiniChip label="Subs suspended" value={c.subsSuspended} />
          <MiniChip label="Lifetime" value={c.subsLifetime} />
          <MiniChip label="Paid payments" value={c.paymentsPaid} />
          <MiniChip label="Revenue ₹" value={Math.round(c.paymentsRevenue / 100)} />
          <MiniChip label="Mirrored assets" value={c.mirrorAssets} />
          <MiniChip label="Discord assets" value={c.discordAssets} />
          <MiniChip label="OAuth states" value={c.oauthStates} />
        </div>
      )}
    </div>
  )
}

function fmtUptime(seconds?: number): string {
  if (seconds == null || Number.isNaN(seconds)) return '—'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function fmtRel(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function fmtExpiry(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now()
  if (diff <= 0) return `expired ${fmtRel(iso)}`
  const m = Math.floor(diff / 60000)
  if (m < 60) return `expires in ${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `expires in ${h}h`
  return `expires in ${Math.floor(h / 24)}d`
}

function SystemBadge({ operational, degraded }: { operational: boolean; degraded: boolean }) {
  const label = operational ? 'All Systems Operational' : degraded ? 'Degraded' : 'Outage'
  const cls = operational
    ? 'bg-green-500/20 text-white/90'
    : degraded
      ? 'bg-amber-500/20 text-white/90'
      : 'bg-red-500/20 text-white/90'
  return (
    <Badge className={`${cls} text-[10px] gap-1.5`}>
      <span className={`w-1.5 h-1.5 rounded-full ${operational ? 'bg-green-400' : degraded ? 'bg-amber-400' : 'bg-red-400'} animate-pulse`} />
      {label}
    </Badge>
  )
}

function ProbeRow({ label, ok, latencyMs, note }: { label: string; ok: boolean; latencyMs: number | null; note?: string }) {
  return (
    <div className="flex items-center justify-between py-1">
      <div className="flex items-center gap-2 text-sm text-white/80">
        <span className={`w-2 h-2 rounded-full ${ok ? 'bg-green-400' : 'bg-red-400'}`} />
        {label}
        {note && <span className="text-[10px] text-white/70 uppercase tracking-wide">{note}</span>}
      </div>
      <span className={`text-xs font-mono ${ok ? 'text-white/60' : 'text-white/70'}`}>
        {latencyMs != null ? `${latencyMs} ms` : '—'}
      </span>
    </div>
  )
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="glass-card-inner p-3 text-center">
      <p className={`text-xl sm:text-2xl font-bold ${color}`}>{value}</p>
      <p className="text-[10px] uppercase tracking-wider text-white/40 mt-1">{label}</p>
    </div>
  )
}

function MiniChip({ label, value }: { label: string; value: number }) {
  return (
    <span className="text-[10px] px-2 py-1 rounded-full bg-white/5 border border-white/10 text-white/50">
      {label}: <span className="text-white/80 font-medium">{value}</span>
    </span>
  )
}

function SettingsGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-white/40 mb-1.5">{title}</p>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

function SettingRow({ label, value, mono, ok, link }: { label: string; value: string; mono?: boolean; ok?: boolean; link?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1 border-b border-white/5 last:border-0">
      <span className="text-xs text-white/50 shrink-0">{label}</span>
      {link ? (
        <a
          href={value.startsWith('http') ? value : `https://${value}`}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-white/90 hover:text-white truncate underline underline-offset-2"
        >
          {value}
        </a>
      ) : (
        <span className={`text-xs text-right truncate ${mono ? 'font-mono' : ''} ${ok === true ? 'text-white/90' : ok === false ? 'text-white/90' : 'text-white/80'}`}>
          {ok === true && <Check className="w-3 h-3 inline-block align-[-2px] mr-1" />}
          {ok === false && <X className="w-3 h-3 inline-block align-[-2px] mr-1" />}
          {value}
        </span>
      )}
    </div>
  )
}

function PaymentRow({ payment: p }: { payment: AdminPaymentRow }) {
  const paid = p.status === 'paid'
  return (
    <div className="glass-card-inner p-3 flex items-center gap-3">
      <img src={p.avatar} alt={p.username} className="w-9 h-9 rounded-full" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-white truncate">{p.username}</span>
          <Badge className={`text-[10px] ${p.plan === 'pro' ? 'bg-purple-500/20 text-white/90' : 'bg-sky-500/20 text-white/90'}`}>
            {p.plan.toUpperCase()}
          </Badge>
          <Badge className={`text-[10px] ${paid ? 'bg-green-500/20 text-white/90' : 'bg-white/5 text-white/40'}`}>
            {paid ? <span className="inline-flex items-center gap-1"><Check className="w-3 h-3" />PAID</span> : 'CREATED'}
          </Badge>
        </div>
        <p className="text-xs text-white/40 font-mono truncate">
          {p.orderId}{p.paymentId ? ` → ${p.paymentId}` : ''}
        </p>
      </div>
      <div className="text-right shrink-0">
        <p className={`text-sm font-bold ${paid ? 'text-white/90' : 'text-white/40'}`}>
          ₹{(p.amount / 100).toLocaleString('en-IN')}
        </p>
        <p className="text-[11px] text-white/30">{fmtRel(p.createdAt)}</p>
      </div>
    </div>
  )
}

function SessionRow({ session: s, busy, onRevoke }: {
  session: AdminSessionRow
  busy: boolean
  onRevoke: () => void
}) {
  return (
    <div className="glass-card-inner p-3 space-y-2">
      <div className="flex items-center gap-3">
        <img src={s.avatar} alt={s.username} className="w-9 h-9 rounded-full" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm font-medium text-white truncate">{s.username}</span>
            {s.isCurrent && <Badge className="bg-green-500/20 text-white/90 text-[10px]">THIS DEVICE</Badge>}
            {!s.isCurrent && s.isSelf && <Badge className="bg-sky-500/20 text-white/90 text-[10px]">YOU (OTHER DEVICE)</Badge>}
          </div>
          <p className="text-xs text-white/40">
            signed in {fmtRel(s.createdAt)} · {fmtExpiry(s.expiresAt)}
          </p>
        </div>
        <div className="flex flex-col gap-1 items-end">
          {s.rpcEnabled ? (
            <Badge className="bg-green-500/20 text-white/90 text-[10px] gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
              RPC LIVE
            </Badge>
          ) : s.statusEnabled ? (
            <Badge className="bg-fuchsia-500/20 text-white/90 text-[10px]">STATUS ON</Badge>
          ) : (
            <Badge className="bg-white/5 text-white/40 text-[10px]">IDLE</Badge>
          )}
          {s.vrStatusActive && <Badge className="bg-cyan-500/20 text-white/90 text-[10px] gap-1"><Glasses className="w-3 h-3" />VR</Badge>}
          {s.sleepTimerActive && <Badge className="bg-indigo-500/20 text-white/90 text-[10px] gap-1"><MoonStar className="w-3 h-3" />SLEEP</Badge>}
        </div>
        <button
          onClick={onRevoke}
          disabled={s.isCurrent || busy}
          title={s.isCurrent ? "This is your current session — it can't be revoked from here" : 'Log out this device'}
          className="text-[11px] px-2.5 py-1 rounded-lg border transition-all shrink-0 disabled:opacity-40 disabled:cursor-not-allowed bg-red-500/10 border-red-500/30 text-white/90 hover:bg-red-500/20"
        >
          {busy ? '…' : s.isCurrent ? 'Current' : 'Revoke'}
        </button>
      </div>
      <div className="flex items-center flex-wrap gap-x-3 gap-y-1 text-xs text-white/50">
        <span className="font-mono text-white/30 text-[10px]">{s.id.slice(0, 12)}…</span>
        {s.hasDiscordToken ? (
          <span className="text-white inline-flex items-center gap-1"><KeyRound className="w-3 h-3" />Token</span>
        ) : (
          <span className="text-white/50 inline-flex items-center gap-1"><TriangleAlert className="w-3 h-3" />No Token</span>
        )}
        <span className={`uppercase ${s.userStatus === 'online' ? 'text-white' : s.userStatus === 'idle' ? 'text-white' : s.userStatus === 'dnd' ? 'text-white' : 'text-white'}`}>
          {s.userStatus}
        </span>
        {s.customStatus && <span className="inline-flex items-center gap-1"><MessageCircle className="w-3 h-3 shrink-0" />{s.customStatusEmoji} {s.customStatus}</span>}
        <span className="inline-flex items-center gap-1"><Smartphone className="w-3 h-3" />{s.statusPlatform}</span>
        {s.lastPresenceUpdate && (
          <span className="text-white/30">push {new Date(s.lastPresenceUpdate).toLocaleTimeString()}</span>
        )}
      </div>
    </div>
  )
}

// --- menu icons (14x14 stroke SVGs) ---
function Icon({ d }: { d: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}
function IconGrid() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" />
    </svg>
  )
}
function IconUsers() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}
function IconClock() {
  return <Icon d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2" />
}
function IconCoin() {
  return <Icon d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM8.5 7h7M8.5 11h7M12 7c2.5 0 3.5 1.2 3.5 2.75S14.5 12.5 12 12.5H8.5L15 18" />
}
function IconPower() {
  return <Icon d="M18.36 6.64a9 9 0 1 1-12.73 0M12 2v10" />
}
function IconGear() {
  return <Icon d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
}
function IconTag() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.59 13.41 11 3.83A2 2 0 0 0 9.59 3.24H4a2 2 0 0 0-2 2v5.59c0 .53.21 1.04.59 1.41l9.58 9.59a2 2 0 0 0 2.83 0l5.59-5.59a2 2 0 0 0 0-2.83z" />
      <circle cx="6.5" cy="7.5" r="1" />
    </svg>
  )
}
function IconChart() {
  return <Icon d="M3 3v18h18M7 15v3M12 10v8M17 6v12" />
}
function IconShield() {
  return <Icon d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
}
