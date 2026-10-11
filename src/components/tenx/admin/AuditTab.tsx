// 10X RPC — admin Audit tab: the tamper-resistant log of every privileged
// action (plan changes, trial policy updates, subscription surgery, notes).
// Filters by action prefix / target type / free text; paginated. Restricted
// to admins server-side — this UI is only the window.
'use client'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api, type AdminAuditRow } from '@/lib/api-client'
import { Card } from '../ui'
import { Chip, fmtDateTime } from './shared'

const ACTION_FILTERS = [
  { id: '', label: 'All' },
  { id: 'subscription', label: 'Subscriptions' },
  { id: 'plan', label: 'Plans' },
  { id: 'trial', label: 'Trials' },
]

const TARGET_TONES: Record<string, string> = {
  user: 'violet',
  plan: 'sky',
  trial_config: 'amber',
  payment: 'green',
  platform: 'gray',
}

export function AuditTab() {
  const [logs, setLogs] = useState<AdminAuditRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(1)
  const [action, setAction] = useState('')
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.adminAudit({ action: action || undefined, q: q || undefined, page, pageSize: 25 })
      setLogs(res.logs)
      setTotal(res.total)
      setPages(res.totalPages)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load audit log')
    } finally {
      setLoading(false)
    }
  }, [action, q, page])

  useEffect(() => { load() }, [load])

  return (
    <Card>
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <h3 className="font-bold text-white">Audit Log <span className="text-xs text-white/40">({total})</span></h3>
        <button onClick={load} className="text-[11px] text-white/60 hover:text-white bg-white/5 border border-white/10 px-2.5 py-1 rounded-lg transition-all">
          ↻ Refresh
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5 mb-2">
        {ACTION_FILTERS.map(f => (
          <button
            key={f.id}
            onClick={() => { setAction(f.id); setPage(1) }}
            className={`text-[11px] px-2.5 py-1 rounded-full border transition-all ${
              action === f.id ? 'bg-purple-500/25 border-purple-500/50 text-white/90' : 'bg-white/5 border-white/10 text-white/50 hover:text-white/80'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>
      <input
        value={q}
        onChange={e => { setQ(e.target.value); setPage(1) }}
        placeholder="Search user, plan, reason or action…"
        aria-label="Search audit log"
        className="w-full bg-[#13141a] border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/30 mb-3 focus:outline-none focus:border-purple-500/50"
      />

      <div className="space-y-2 max-h-[55vh] overflow-y-auto styled-scroll">
        {loading && logs.length === 0 ? (
          <p className="text-sm text-white/40 text-center py-6">Loading audit log…</p>
        ) : logs.length === 0 ? (
          <p className="text-sm text-white/40 text-center py-6">No admin actions recorded yet — changes made in Plans / Trials / Users will appear here.</p>
        ) : (
          logs.map(l => {
            const before = safeParse(l.beforeJson)
            const after = safeParse(l.afterJson)
            return (
              <div key={l.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                <button onClick={() => setExpanded(expanded === l.id ? null : l.id)} className="w-full text-left">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-mono text-white/85">{l.action}</span>
                    {l.targetType && <Chip tone={TARGET_TONES[l.targetType] ?? 'gray'}>{l.targetType}</Chip>}
                    {l.targetLabel && <span className="text-xs text-white/70">{l.targetLabel}</span>}
                    <Chip tone={l.outcome === 'ok' ? 'green' : 'red'}>{l.outcome}</Chip>
                    <span className="text-[10px] text-white/30 ml-auto">{fmtDateTime(l.createdAt)}</span>
                  </div>
                  <p className="text-[11px] text-white/45 mt-1">
                    by <b className="text-white/60 font-normal">{l.actorName ?? l.actorId}</b>
                    {l.reason && <> · reason: <span className="text-white/55 italic">&ldquo;{l.reason}&rdquo;</span></>}
                  </p>
                </button>
                {expanded === l.id && (before || after) && (
                  <div className="mt-2 grid sm:grid-cols-2 gap-2 border-t border-white/5 pt-2">
                    <SnapshotBox label="Before" data={before} />
                    <SnapshotBox label="After" data={after} />
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      {pages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-3">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="text-xs px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white/60 hover:text-white disabled:opacity-30 transition-all"
          >
            ← Prev
          </button>
          <span className="text-xs text-white/40">{page} / {pages}</span>
          <button
            onClick={() => setPage(p => Math.min(pages, p + 1))}
            disabled={page >= pages}
            className="text-xs px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white/60 hover:text-white disabled:opacity-30 transition-all"
          >
            Next →
          </button>
        </div>
      )}
    </Card>
  )
}

function SnapshotBox({ label, data }: { label: string; data: Record<string, unknown> | null }) {
  if (!data) return <div />
  return (
    <div className="rounded-lg bg-black/30 border border-white/5 p-2">
      <p className="text-[10px] uppercase tracking-wider text-white/40 mb-1">{label}</p>
      <div className="space-y-0.5">
        {Object.entries(data).slice(0, 10).map(([k, v]) => (
          <div key={k} className="flex justify-between gap-2 text-[10px]">
            <span className="text-white/40">{k}</span>
            <span className="text-white/70 font-mono truncate max-w-[60%]">{formatValue(v)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function safeParse(json: string | null): Record<string, unknown> | null {
  if (!json) return null
  try {
    const v = JSON.parse(json)
    return v && typeof v === 'object' ? v as Record<string, unknown> : null
  } catch {
    return null
  }
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (typeof v === 'string') {
    // ISO dates → short local form
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return fmtDateTime(v)
    return v
  }
  return String(v)
}
