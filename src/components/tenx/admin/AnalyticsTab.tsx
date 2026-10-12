// 10X RPC — admin Analytics tab: subscription analytics computed from the
// live database (no mocks): lifecycle counts, trial→paid conversion, plan
// popularity, verified revenue, renewals, upcoming expirations and a 14-day
// signup/activation/revenue trend.
'use client'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api, type AdminAnalytics } from '@/lib/api-client'
import { Card } from '../ui'
import { StatCard, rupees } from './shared'

export function AnalyticsTab() {
  const [data, setData] = useState<AdminAnalytics | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await api.adminAnalytics())
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load analytics')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  if (loading && !data) return <Card><p className="text-sm text-white/40 text-center py-6">Computing analytics…</p></Card>
  if (!data) return <Card><p className="text-sm text-white/40 text-center py-6">Analytics unavailable.</p></Card>

  const s = data.subscriptions
  const maxTrend = Math.max(...data.trend.map(t => Math.max(t.signups, t.paid)), 1)
  const maxPlanRev = Math.max(1, ...data.planPopularity.payments.map(p => p.revenuePaise))
  const maxPlanCount = Math.max(1, ...data.planPopularity.subscriptions.map(p => p.count))

  return (
    <div className="space-y-4">
      {/* lifecycle */}
      <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
        <StatCard label="Subscriptions" value={s.total} color="text-red-300" />
        <StatCard label="Active paid" value={s.active} color="text-green-400" sub={`${s.lifetime} lifetime`} />
        <StatCard label="Trialing" value={s.trialing} color="text-red-300" />
        <StatCard label="Expired" value={s.expired} color="text-red-300" />
        <StatCard label="Admin-suspended" value={s.adminSuspended} color="text-amber-300" />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <StatCard label="Trial→Paid" value={`${data.conversion.rate}%`} color="text-emerald-300" sub={`${data.conversion.payingUsers}/${data.conversion.everTrialed}`} />
        <StatCard label="Revenue all-time" value={rupees(data.revenue.allTimePaise)} color="text-amber-300" />
        <StatCard label="Revenue 30d" value={rupees(data.revenue.last30dPaise)} color="text-emerald-400" />
        <StatCard label="Payments paid" value={data.revenue.paidCount} color="text-red-400" sub={`${data.conversion.renewals} renewals`} />
        <StatCard label="Expiring ≤7d" value={s.expiring7d} color="text-amber-300" sub={`${s.expiring30d} in 30d`} />
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        {/* plan popularity */}
        <Card>
          <h3 className="font-bold text-white mb-3">Plan Popularity</h3>
          <div className="space-y-2.5">
            {data.planPopularity.subscriptions.length === 0 && data.planPopularity.payments.length === 0 ? (
              <p className="text-sm text-white/40 text-center py-4">No subscription data yet.</p>
            ) : (
              <>
                <p className="text-[10px] uppercase tracking-wider text-white/40">By current subscriptions</p>
                {data.planPopularity.subscriptions.map(g => (
                  <div key={`sub-${g.plan}`} className="flex items-center gap-2">
                    <span className="text-[11px] text-white/70 w-16 shrink-0 capitalize">{g.plan}</span>
                    <div className="flex-1 h-3.5 rounded-full bg-white/5 overflow-hidden">
                      <div className="h-full rounded-full bg-gradient-to-r from-purple-500/70 to-fuchsia-400/80" style={{ width: `${Math.max(4, (g.count / maxPlanCount) * 100)}%` }} />
                    </div>
                    <span className="text-[11px] text-white/50 w-10 text-right">{g.count}</span>
                  </div>
                ))}
                {data.planPopularity.payments.length > 0 && (
                  <>
                    <p className="text-[10px] uppercase tracking-wider text-white/40 pt-2 border-t border-white/5">By verified revenue</p>
                    {data.planPopularity.payments.map(g => (
                      <div key={`pay-${g.plan}`} className="flex items-center gap-2">
                        <span className="text-[11px] text-white/70 w-16 shrink-0 capitalize">{g.plan}</span>
                        <div className="flex-1 h-3.5 rounded-full bg-white/5 overflow-hidden">
                          <div className="h-full rounded-full bg-gradient-to-r from-amber-500/70 to-amber-300/80" style={{ width: `${Math.max(4, (g.revenuePaise / maxPlanRev) * 100)}%` }} />
                        </div>
                        <span className="text-[11px] text-white/70 w-20 text-right">{rupees(g.revenuePaise)}</span>
                      </div>
                    ))}
                  </>
                )}
              </>
            )}
          </div>
        </Card>

        {/* 14-day trend */}
        <Card>
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-bold text-white">14-Day Trend</h3>
            <span className="text-[11px] text-white/40">
              revenue {rupees(data.trend.reduce((a, t) => a + t.revenuePaise, 0))}
            </span>
          </div>
          <div className="flex items-end gap-1 h-28">
            {data.trend.map(t => (
              <div key={t.date} className="flex-1 flex flex-col items-center justify-end h-full gap-0.5" title={`${t.date}: ${t.signups} signups · ${t.paid} paid · ${rupees(t.revenuePaise)}`}>
                <div className="w-full flex items-end justify-center gap-px h-full">
                  <div
                    className={`w-1/2 rounded-t-sm ${t.signups > 0 ? 'bg-purple-400/70' : 'bg-white/5'}`}
                    style={{ height: `${t.signups > 0 ? Math.max(8, (t.signups / maxTrend) * 100) : 4}%` }}
                  />
                  <div
                    className={`w-1/2 rounded-t-sm ${t.paid > 0 ? 'bg-amber-400/80' : 'bg-white/5'}`}
                    style={{ height: `${t.paid > 0 ? Math.max(8, (t.paid / maxTrend) * 100) : 4}%` }}
                  />
                </div>
                <span className="text-[8px] text-white/30">{t.date.slice(8)}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-3 text-[10px] text-white/40 mt-2">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-purple-400/70" /> signups</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-amber-400/80" /> paid</span>
          </div>
        </Card>
      </div>

      <p className="text-[10px] text-white/30">
        All numbers are computed from the live database at {new Date(data.checkedAt).toLocaleTimeString('en-IN')} — no cached or mocked figures.
      </p>
    </div>
  )
}
