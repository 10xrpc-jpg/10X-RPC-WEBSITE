// 10X RPC — admin Users tab (subscription-management edition).
// Server-side search / status & plan filters / sorting / pagination against
// /api/admin/subscriptions — built for large user lists. Summary cards show
// the live lifecycle split; every row opens the SubscriptionModal for the
// full per-user subscription surgery (days, dates, plans, suspend, notes).
'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { api, type AdminSubFilter, type AdminSubUser, type AdminSubscriptionsResponse } from '@/lib/api-client'
import { Card } from '../ui'
import { Chip, StatCard, SubStateBadge, fmtDate, fmtRel, planLabel } from './shared'
import { SubscriptionModal } from './SubscriptionModal'

const STATUS_FILTERS: { id: AdminSubFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'trialing', label: '⏳ Trial' },
  { id: 'active', label: '★ Paid' },
  { id: 'expiring', label: '⚠ Expiring 7d' },
  { id: 'suspended', label: '⛔ Suspended' },
  { id: 'expired', label: '✕ Expired' },
]

const SORTS: { id: string; label: string }[] = [
  { id: '-createdAt', label: 'Newest' },
  { id: 'createdAt', label: 'Oldest' },
  { id: '-expiry', label: 'Expiring soon' },
  { id: 'expiry', label: 'Latest expiry' },
  { id: '-daysLeft', label: 'Most days left' },
  { id: 'username', label: 'Name A–Z' },
]

export function UsersTab() {
  const [data, setData] = useState<AdminSubscriptionsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<AdminSubFilter>('all')
  const [plan, setPlan] = useState('all')
  const [sort, setSort] = useState('-createdAt')
  const [page, setPage] = useState(1)
  const [detailId, setDetailId] = useState<string | null>(null)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true)
    try {
      const res = await api.adminSubscriptions({ q, status, plan, sort, page, pageSize: 25 })
      setData(res)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load users')
    } finally {
      setLoading(false)
    }
  }, [q, status, plan, sort, page])

  useEffect(() => { load() }, [load])

  const onSearch = (v: string) => {
    setQ(v)
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => setPage(1), 350)
  }

  const s = data?.summary
  const plans = Array.from(new Set((data?.users ?? []).map(u => u.subscription.plan))).sort()

  return (
    <div className="space-y-4">
      {/* summary cards */}
      {s && (
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
          <StatCard label="Users" value={s.total} color="text-red-300" />
          <StatCard label="Paid active" value={s.active} color="text-green-400" />
          <StatCard label="Trials" value={s.trialing} color="text-red-300" />
          <StatCard label="Expiring 7d" value={s.expiringSoon} color="text-amber-300" />
          <StatCard label="Suspended" value={s.suspended} color="text-red-300" />
          <StatCard label="Lifetime" value={s.lifetime} color="text-sky-300" />
        </div>
      )}

      <Card>
        <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
          <h3 className="font-bold text-white">Users {data ? `(${data.filtered})` : ''}</h3>
          <span className="text-xs text-white/40">
            {data ? `page ${data.page}/${data.totalPages}` : ''}
          </span>
        </div>

        {/* search + filters */}
        <input
          value={q}
          onChange={e => onSearch(e.target.value)}
          placeholder="Search username, Discord ID or user id…"
          aria-label="Search users"
          className="w-full bg-[#13141a] border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/30 mb-2 focus:outline-none focus:border-purple-500/50"
        />
        <div className="flex flex-wrap gap-1.5 mb-2">
          {STATUS_FILTERS.map(f => (
            <button
              key={f.id}
              onClick={() => { setStatus(f.id); setPage(1) }}
              className={`text-[11px] px-2.5 py-1 rounded-full border transition-all ${
                status === f.id ? 'bg-purple-500/25 border-purple-500/50 text-red-200' : 'bg-white/5 border-white/10 text-white/50 hover:text-white/80'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5 mb-3 items-center">
          <select
            value={plan}
            onChange={e => { setPlan(e.target.value); setPage(1) }}
            aria-label="Filter by plan"
            className="bg-[#13141a] border border-white/10 rounded-lg px-2 py-1 text-[11px] text-white focus:outline-none focus:border-purple-500/50"
          >
            <option value="all">All plans</option>
            <option value="free">Free</option>
            <option value="plus">Plus</option>
            <option value="pro">Pro</option>
            <option value="lifetime">Lifetime</option>
            {plans.filter(p => !['free', 'plus', 'pro', 'lifetime'].includes(p)).map(p => (
              <option key={p} value={p}>{planLabel(p)}</option>
            ))}
          </select>
          <select
            value={sort}
            onChange={e => { setSort(e.target.value); setPage(1) }}
            aria-label="Sort users"
            className="bg-[#13141a] border border-white/10 rounded-lg px-2 py-1 text-[11px] text-white focus:outline-none focus:border-purple-500/50"
          >
            {SORTS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
          <button onClick={() => load()} className="text-[11px] text-white/60 hover:text-white bg-white/5 border border-white/10 px-2.5 py-1 rounded-lg transition-all">
            ↻ Refresh
          </button>
        </div>

        {/* rows */}
        <div className="space-y-2 max-h-[60vh] overflow-y-auto styled-scroll">
          {loading && !data ? (
            <p className="text-sm text-white/40 text-center py-6">Loading users…</p>
          ) : (data?.users.length ?? 0) === 0 ? (
            <p className="text-sm text-white/40 text-center py-6">No users match this search/filter.</p>
          ) : (
            data!.users.map(u => (
              <UserSubRow key={u.id} user={u} onOpen={() => setDetailId(u.id)} />
            ))
          )}
        </div>

        {/* pagination */}
        {data && data.totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 pt-3">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="text-xs px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white/60 hover:text-white disabled:opacity-30 transition-all"
            >
              ← Prev
            </button>
            <span className="text-xs text-white/40">{page} / {data.totalPages}</span>
            <button
              onClick={() => setPage(p => Math.min(data.totalPages, p + 1))}
              disabled={page >= data.totalPages}
              className="text-xs px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white/60 hover:text-white disabled:opacity-30 transition-all"
            >
              Next →
            </button>
          </div>
        )}
      </Card>

      {detailId && (
        <SubscriptionModal
          userId={detailId}
          onClose={() => setDetailId(null)}
          onChanged={() => load({ silent: true })}
        />
      )}
    </div>
  )
}

function UserSubRow({ user, onOpen }: { user: AdminSubUser; onOpen: () => void }) {
  return (
    <button onClick={onOpen} className="glass-card-inner p-3 w-full text-left hover:border-purple-500/30 transition-all">
      <div className="flex items-center gap-3">
        <img src={user.avatar} alt={user.username} className="w-9 h-9 rounded-full" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-white truncate">{user.username}</span>
            {user.isAdmin && <Chip tone="amber">ADMIN</Chip>}
            <SubStateBadge sub={user.subscription} isAdmin={user.isAdmin} />
          </div>
          <p className="text-[11px] text-white/40 font-mono truncate">{user.discordId}</p>
          <div className="flex items-center gap-x-3 gap-y-0.5 flex-wrap text-[10px] text-white/35 mt-0.5">
            <span>joined {fmtDate(user.createdAt)}</span>
            {user.lastPayment && (
              <span className="text-amber-300/70">
                last: {user.lastPayment.planLabel ?? user.lastPayment.plan} · ₹{(user.lastPayment.amount / 100).toLocaleString('en-IN')} · {fmtRel(user.lastPayment.createdAt)}
              </span>
            )}
            {user.session?.rpcEnabled && <span className="text-green-400">● RPC live</span>}
            {user.adminNote && <span className="text-red-300/70 truncate max-w-[180px]">📝 {user.adminNote}</span>}
          </div>
        </div>
        <span className="text-white/30 text-xs shrink-0">Manage ▸</span>
      </div>
    </button>
  )
}
