// 10X RPC — Admin dashboard page (/admin)
// Sections: System Health (live probes) → Platform Stats → 24/7 RPC Control →
// User Manager (search / filters / per-user actions).
// Access: Discord IDs in ADMIN_DISCORD_IDS only — every /api/admin/* endpoint
// re-checks server-side, this UI is just the window.
'use client'
import { useEffect, useState, useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { api, type AdminUser, type AdminStats, type AdminUserAction } from '@/lib/api-client'
import { useRouter } from './useRouter'
import { Card, PrimaryButton, GhostButton, BackButton, Badge } from './ui'

type UserFilter = 'all' | 'live' | 'notoken' | 'expired' | 'vr' | 'admins'

export function AdminPage() {
  const { navigate } = useRouter()
  const [users, setUsers] = useState<AdminUser[]>([])
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<UserFilter>('all')
  const [expanded, setExpanded] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      // Users are the core payload; stats are best-effort (probes can be slow).
      const [usersRes, statsRes] = await Promise.all([
        api.adminUsers(),
        api.adminStats().catch(() => null),
      ])
      setUsers(usersRes.users)
      setStats(statsRes)
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

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 30000) // auto-refresh every 30s
    return () => clearInterval(t)
  }, [refresh])

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

  const runAction = async (u: AdminUser, action: AdminUserAction) => {
    if (action === 'revoke-sessions' && !window.confirm(
      `Revoke ALL sessions for ${u.username}? They will be logged out everywhere and must sign in again.`
    )) return
    const key = `${u.id}:${action}`
    setActionBusy(key)
    try {
      const r = await api.adminUserAction(u.id, action)
      if (r.ok) toast.success(r.message, { duration: 4000 })
      else toast.error(r.message, { duration: 5000 })
      refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setActionBusy(null)
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return users.filter(u => {
      if (q && !u.username.toLowerCase().includes(q) && !u.discordId.includes(q)) return false
      switch (filter) {
        case 'live': return !!u.rpc?.rpcEnabled
        case 'notoken': return !u.rpc?.hasDiscordToken
        case 'expired': return !u.trial?.active
        case 'vr': return !!u.rpc?.vrStatusActive
        case 'admins': return u.isAdmin
        default: return true
      }
    })
  }, [users, search, filter])

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
            <div className="text-4xl">🔒</div>
            <p className="text-white/70 font-medium">Access Denied</p>
            <p className="text-sm text-white/50 max-w-xs mx-auto">{error}</p>
          </div>
        </Card>
      </div>
    )
  }

  const c = stats?.counts
  const sys = stats?.system

  return (
    <div className="min-h-screen px-4 sm:px-6 py-6 max-w-3xl mx-auto pb-12">
      <div className="flex items-center justify-between mb-6">
        <BackButton onClick={() => navigate({ name: 'dashboard' })} />
        <h1 className="text-2xl font-bold text-white">Admin Dashboard</h1>
        <button
          onClick={refresh}
          aria-label="Refresh data"
          className="text-xs text-white/60 hover:text-white bg-white/5 border border-white/10 px-3 py-1.5 rounded-lg hover:bg-white/10 transition-all"
        >
          ↻ Refresh
        </button>
      </div>

      {/* System health */}
      <Card className="mb-4">
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
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-4">
        <StatCard label="Users" value={c ? c.totalUsers : users.length} color="text-purple-300" />
        <StatCard label="RPC Live" value={c?.rpcLive ?? users.filter(u => u.rpc?.rpcEnabled).length} color="text-green-400" />
        <StatCard label="With Token" value={c?.sessionsWithToken ?? users.filter(u => u.rpc?.hasDiscordToken).length} color="text-sky-400" />
        <StatCard label="Status On" value={c?.statusEnabled ?? 0} color="text-fuchsia-400" />
        <StatCard label="VR Active" value={c?.vrActive ?? users.filter(u => u.rpc?.vrStatusActive).length} color="text-cyan-300" />
        <StatCard label="New 24h" value={c?.newUsers24h ?? 0} color="text-amber-300" />
      </div>

      {/* Secondary counters */}
      {c && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          <MiniChip label="Active sessions" value={c.activeSessions} />
          <MiniChip label="Sleep timers" value={c.sleepTimersActive} />
          <MiniChip label="Games live" value={c.gamesEnabled} />
          <MiniChip label="Custom games" value={c.customGames} />
          <MiniChip label="Rotator users" value={c.rotatorEnabledUsers} />
          <MiniChip label="Presets" value={c.rotatorPresets} />
          <MiniChip label="Favorites" value={c.favorites} />
          <MiniChip label="Trials active" value={c.trialsActive} />
          <MiniChip label="Trials expired" value={c.trialsExpired} />
          <MiniChip label="Mirrored assets" value={c.mirrorAssets} />
          <MiniChip label="Discord assets" value={c.discordAssets} />
          <MiniChip label="OAuth states" value={c.oauthStates} />
        </div>
      )}

      {/* 24/7 control */}
      <Card className="mb-4">
        <h3 className="font-bold text-white mb-3">24/7 RPC Control</h3>
        <div className="grid grid-cols-3 gap-2">
          <PrimaryButton onClick={handleForceEnable} disabled={busy} className="text-xs">
            {busy ? '...' : 'Force Enable All'}
          </PrimaryButton>
          <GhostButton onClick={handleKeepAlive} disabled={busy} className="text-xs">
            {busy ? '...' : 'Keep-Alive Now'}
          </GhostButton>
          <GhostButton onClick={handleForceDisable} disabled={busy} className="text-xs text-red-400">
            {busy ? '...' : 'Disable All'}
          </GhostButton>
        </div>
        <p className="text-xs text-white/40 mt-3">
          Force Enable: pushes RPC + status + VR icon for all users with Discord tokens.
          Keep-Alive: refreshes presence for all active users (call every 5 min for 24/7).
        </p>
      </Card>

      {/* User manager */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold text-white">All Users ({users.length})</h3>
          <span className="text-xs text-white/40">showing {filtered.length}</span>
        </div>

        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search username or Discord ID…"
          aria-label="Search users"
          className="w-full bg-[#13141a] border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/30 mb-2 focus:outline-none focus:border-purple-500/50"
        />

        <div className="flex flex-wrap gap-1.5 mb-3">
          {(['all', 'live', 'notoken', 'expired', 'vr', 'admins'] as UserFilter[]).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`text-[11px] px-2.5 py-1 rounded-full border transition-all ${
                filter === f
                  ? 'bg-purple-500/25 border-purple-500/50 text-purple-200'
                  : 'bg-white/5 border-white/10 text-white/50 hover:text-white/80'
              }`}
            >
              {f === 'all' ? 'All' : f === 'live' ? 'RPC Live' : f === 'notoken' ? 'No Token' : f === 'expired' ? 'Trial Ended' : f === 'vr' ? 'VR' : 'Admins'}
            </button>
          ))}
        </div>

        <div className="space-y-2 max-h-[60vh] overflow-y-auto styled-scroll">
          {filtered.length === 0 ? (
            <p className="text-sm text-white/40 text-center py-6">No users match this search/filter.</p>
          ) : (
            filtered.map(u => (
              <UserRow
                key={u.id}
                user={u}
                expanded={expanded === u.id}
                onToggle={() => setExpanded(expanded === u.id ? null : u.id)}
                actionBusy={actionBusy}
                onAction={runAction}
              />
            ))
          )}
        </div>
      </Card>
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

function SystemBadge({ operational, degraded }: { operational: boolean; degraded: boolean }) {
  const label = operational ? 'All Systems Operational' : degraded ? 'Degraded' : 'Outage'
  const cls = operational
    ? 'bg-green-500/20 text-green-300'
    : degraded
      ? 'bg-amber-500/20 text-amber-300'
      : 'bg-red-500/20 text-red-300'
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
        {note && <span className="text-[10px] text-amber-300/80 uppercase tracking-wide">{note}</span>}
      </div>
      <span className={`text-xs font-mono ${ok ? 'text-white/60' : 'text-red-300/80'}`}>
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

function UserRow({ user, expanded, onToggle, actionBusy, onAction }: {
  user: AdminUser
  expanded: boolean
  onToggle: () => void
  actionBusy: string | null
  onAction: (u: AdminUser, action: AdminUserAction) => void
}) {
  const rpc = user.rpc
  const busyFor = (action: AdminUserAction) => actionBusy === `${user.id}:${action}`
  return (
    <div className="glass-card-inner p-3 space-y-2">
      <div className="flex items-center gap-3">
        <img src={user.avatar} alt={user.username} className="w-10 h-10 rounded-full" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-white truncate">{user.username}</span>
            {user.isAdmin && (
              <Badge className="bg-purple-500/20 text-purple-300 text-[10px]">ADMIN</Badge>
            )}
          </div>
          <p className="text-xs text-white/40 font-mono">{user.discordId}</p>
        </div>
        <div className="flex flex-col gap-1 items-end">
          {rpc?.rpcEnabled ? (
            <Badge className="bg-green-500/20 text-green-300 text-[10px] gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
              RPC LIVE
            </Badge>
          ) : (
            <Badge className="bg-white/5 text-white/40 text-[10px]">RPC OFF</Badge>
          )}
          {rpc?.vrStatusActive && (
            <Badge className="bg-cyan-500/20 text-cyan-300 text-[10px]">🥽 VR</Badge>
          )}
        </div>
        <button
          onClick={onToggle}
          aria-label={expanded ? 'Hide user actions' : 'Show user actions'}
          aria-expanded={expanded}
          className="text-white/40 hover:text-white text-xs px-2 py-1 rounded-md hover:bg-white/5 transition-all shrink-0"
        >
          {expanded ? '▲' : '▼'}
        </button>
      </div>
      <div className="flex items-center flex-wrap gap-x-3 gap-y-1 text-xs text-white/50">
        <span>📅 {user.trial?.active ? `${user.trial.daysLeft}d left` : 'trial ended'}</span>
        {rpc?.customStatus && (
          <span>💬 {rpc.customStatusEmoji} {rpc.customStatus}</span>
        )}
        {rpc?.userStatus && (
          <span className={`uppercase ${rpc.userStatus === 'online' ? 'text-green-400' : rpc.userStatus === 'idle' ? 'text-yellow-400' : rpc.userStatus === 'dnd' ? 'text-red-400' : 'text-gray-400'}`}>
            {rpc.userStatus}
          </span>
        )}
        {user.rpcConfig && (
          <span>🎮 {user.rpcConfig.name}</span>
        )}
        {rpc?.hasDiscordToken ? (
          <span className="text-green-400">🔑 Token</span>
        ) : (
          <span className="text-yellow-400/60">⚠ No Token</span>
        )}
        {rpc?.lastPresenceUpdate && (
          <span className="text-white/30">
            {new Date(rpc.lastPresenceUpdate).toLocaleTimeString()}
          </span>
        )}
      </div>
      {expanded && (
        <div className="flex flex-wrap gap-1.5 pt-1 border-t border-white/5">
          <ActionButton
            label="Enable RPC" tone="green" busy={busyFor('enable-rpc')}
            onClick={() => onAction(user, 'enable-rpc')} />
          <ActionButton
            label="Disable RPC" tone="red" busy={busyFor('disable-rpc')}
            onClick={() => onAction(user, 'disable-rpc')} />
          <ActionButton
            label="+30d Trial" tone="purple" busy={busyFor('extend-trial')}
            onClick={() => onAction(user, 'extend-trial')} />
          <ActionButton
            label="Revoke Sessions" tone="red" busy={busyFor('revoke-sessions')}
            onClick={() => onAction(user, 'revoke-sessions')} />
        </div>
      )}
    </div>
  )
}

function ActionButton({ label, tone, busy, onClick }: {
  label: string
  tone: 'green' | 'red' | 'purple'
  busy: boolean
  onClick: () => void
}) {
  const tones: Record<string, string> = {
    green: 'bg-green-500/15 border-green-500/30 text-green-300 hover:bg-green-500/25',
    red: 'bg-red-500/10 border-red-500/30 text-red-300 hover:bg-red-500/20',
    purple: 'bg-purple-500/15 border-purple-500/30 text-purple-300 hover:bg-purple-500/25',
  }
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={`text-[11px] px-2.5 py-1 rounded-lg border transition-all disabled:opacity-50 ${tones[tone]}`}
    >
      {busy ? '…' : label}
    </button>
  )
}
