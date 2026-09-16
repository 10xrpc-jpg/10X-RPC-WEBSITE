// 10X RPC — Admin dashboard page (#/admin)
'use client'
import { useEffect, useState, useCallback } from 'react'
import { toast } from 'sonner'
import { api, type AdminUser } from '@/lib/api-client'
import { useRouter } from './useRouter'
import { Card, PrimaryButton, GhostButton, BackButton, Badge } from './ui'

export function AdminPage() {
  const { navigate } = useRouter()
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [activeRpcCount, setActiveRpcCount] = useState(0)

  const refresh = useCallback(async () => {
    try {
      const r = await api.adminUsers()
      setUsers(r.users)
      setActiveRpcCount(r.activeRpcUsers)
      setError(null)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load'
      if (msg.includes('forbidden')) {
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
    } catch (e) {
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
    } catch (e) {
      toast.error('Keep-alive failed')
    } finally {
      setBusy(false)
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
            <div className="text-4xl">🔒</div>
            <p className="text-white/70 font-medium">Access Denied</p>
            <p className="text-sm text-white/50 max-w-xs mx-auto">{error}</p>
          </div>
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-screen px-4 sm:px-6 py-6 max-w-3xl mx-auto pb-12">
      <div className="flex items-center justify-between mb-6">
        <BackButton onClick={() => navigate({ name: 'dashboard' })} />
        <h1 className="text-2xl font-bold text-white">Admin Dashboard</h1>
        <div className="w-16" />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2 mb-6">
        <StatCard label="Total Users" value={users.length} color="text-purple-300" />
        <StatCard label="Active RPC" value={activeRpcCount} color="text-green-400" />
        <StatCard label="With Token" value={users.filter(u => u.rpc?.hasDiscordToken).length} color="text-blue-400" />
      </div>

      {/* Action buttons */}
      <Card className="mb-6">
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

      {/* User list */}
      <Card>
        <h3 className="font-bold text-white mb-3">All Users ({users.length})</h3>
        <div className="space-y-2 max-h-[60vh] overflow-y-auto styled-scroll">
          {users.map(u => (
            <UserRow key={u.id} user={u} />
          ))}
        </div>
      </Card>
    </div>
  )
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="glass-card-inner p-3 text-center">
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
      <p className="text-[10px] uppercase tracking-wider text-white/40 mt-1">{label}</p>
    </div>
  )
}

function UserRow({ user }: { user: AdminUser }) {
  const rpc = user.rpc
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
            <Badge className="bg-green-500/20 text-green-300 text-[10px]">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
              RPC LIVE
            </Badge>
          ) : (
            <Badge className="bg-white/5 text-white/40 text-[10px]">RPC OFF</Badge>
          )}
          {rpc?.vrStatusActive && (
            <Badge className="bg-blue-500/20 text-blue-300 text-[10px]">🥽 VR</Badge>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3 text-xs text-white/50">
        <span>📅 {user.trial?.daysLeft ?? 0}d left</span>
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
    </div>
  )
}
