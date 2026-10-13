// 10X RPC — shared building blocks for the admin subscription-management UI.
// Small, dependency-free pieces reused by the Plans / Trials / Users /
// Analytics / Audit tabs: stat cards, status chips, ₹ formatting, relative
// time and the reason-required confirmation dialog used before every
// sensitive subscription change.
'use client'
import { useState, type ReactNode } from 'react'
import { Crown, Hourglass, CircleX, Ban, AlarmClock, Star, Infinity as InfinityIcon } from 'lucide-react'

/** Paise → ₹ string (₹399 / ₹1,234). */
export function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN')}`
}

/** ISO → "12 Jan 2026, 14:05 IST" (the admin's local time). */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function fmtRel(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function fmtUntil(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const diff = new Date(iso).getTime() - Date.now()
  if (Number.isNaN(diff)) return '—'
  if (diff <= 0) {
    const past = Math.floor(-diff / 60000)
    if (past < 60) return `expired ${past}m ago`
    const h = Math.floor(past / 60)
    if (h < 48) return `expired ${h}h ago`
    return `expired ${Math.floor(h / 24)}d ago`
  }
  const m = Math.floor(diff / 60000)
  if (m < 60) return `in ${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `in ${h}h`
  return `in ${Math.floor(h / 24)}d`
}

/** True when a suspended subscription actually ran out of time (vs an
 *  admin suspension) — derived, no extra status in the model. */
export function isExpiredState(sub: { status: string; endsAt: string | null } | null | undefined): boolean {
  if (!sub || sub.status !== 'suspended') return false
  if (!sub.endsAt) return true // suspended with no recorded end = expired-or-never-had
  return new Date(sub.endsAt).getTime() <= Date.now()
}

/** Lifecycle chip — visually distinguishes trial / paid / expiring /
 *  expired / suspended / lifetime / admin. */
export function SubStateBadge({ sub, isAdmin }: {
  sub: { plan: string; status: string; daysLeft: number; neverExpires: boolean; endsAt: string | null } | null | undefined
  isAdmin?: boolean
}) {
  if (isAdmin) return <Chip tone="amber"><Crown className="w-3 h-3" />Admin bypass</Chip>
  if (!sub) return <Chip tone="gray">no subscription</Chip>
  if (sub.status === 'trialing') {
    return sub.daysLeft <= 1 ? <Chip tone="amber"><Hourglass className="w-3 h-3" />Trial · last day</Chip> : <Chip tone="violet"><Hourglass className="w-3 h-3" />Trial · {sub.daysLeft}d left</Chip>
  }
  if (sub.status === 'suspended') {
    return isExpiredState(sub) ? <Chip tone="red"><CircleX className="w-3 h-3" />Expired</Chip> : <Chip tone="red"><Ban className="w-3 h-3" />Suspended</Chip>
  }
  // active
  if (sub.plan === 'lifetime' || sub.neverExpires) return <Chip tone="green"><InfinityIcon className="w-3 h-3" />Lifetime</Chip>
  if (sub.daysLeft <= 3) return <Chip tone="amber"><AlarmClock className="w-3 h-3" />{planLabel(sub.plan)} · expiring</Chip>
  return <Chip tone="green"><Star className="w-3 h-3" />{planLabel(sub.plan)} · {sub.daysLeft}d left</Chip>
}

export function planLabel(plan: string): string {
  if (plan === 'plus') return 'Plus'
  if (plan === 'pro') return 'Pro'
  if (plan === 'lifetime') return 'Lifetime'
  if (plan === 'free') return 'Free'
  return plan.charAt(0).toUpperCase() + plan.slice(1)
}

const CHIP_TONES: Record<string, string> = {
  green: 'bg-green-500/15 text-emerald-300 border-green-500/30',
  red: 'bg-red-500/15 text-red-300 border-red-500/30',
  amber: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  violet: 'bg-purple-500/15 text-purple-300 border-purple-500/30',
  sky: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  gray: 'bg-white/5 text-white/40 border-white/10',
}

export function Chip({ tone, children }: { tone: keyof typeof CHIP_TONES | string; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border ${CHIP_TONES[tone] ?? CHIP_TONES.gray}`}>
      {children}
    </span>
  )
}

export function StatCard({ label, value, color, sub }: { label: string; value: string | number; color: string; sub?: string }) {
  return (
    <div className="glass-card-inner p-3 text-center">
      <p className={`text-xl sm:text-2xl font-bold ${color}`}>{value}</p>
      <p className="text-[10px] uppercase tracking-wider text-white/40 mt-1">{label}</p>
      {sub && <p className="text-[10px] text-white/30 mt-0.5">{sub}</p>}
    </div>
  )
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative w-10 h-5.5 rounded-full transition-colors shrink-0 disabled:opacity-40 ${checked ? 'bg-purple-500' : 'bg-white/15'}`}
      style={{ height: 22 }}
    >
      <span className={`absolute top-0.5 w-4.5 h-4.5 rounded-full bg-white transition-all ${checked ? 'left-[22px]' : 'left-0.5'}`} style={{ width: 18, height: 18 }} />
    </button>
  )
}

/**
 * Reason-required confirmation dialog. Every sensitive subscription change
 * routes through this: it restates WHO is affected and WHAT will change and
 * demands a free-text reason before firing (the backend rejects requests
 * without one, so the UI and the API agree).
 */
export function ConfirmDialog({ open, title, description, confirmLabel, danger, busy, onConfirm, onCancel }: {
  open: boolean
  title: string
  description: ReactNode
  confirmLabel: string
  danger?: boolean
  busy?: boolean
  onConfirm: (reason: string) => void
  onCancel: () => void
}) {
  const [reason, setReason] = useState('')
  if (!open) return null
  const valid = reason.trim().length >= 3
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-3" role="dialog" aria-modal="true" aria-label={title}>
      <div className="glass-card-inner w-full max-w-md p-4 space-y-3">
        <h4 className={`font-bold ${danger ? 'text-white/90' : 'text-white'}`}>{title}</h4>
        <div className="text-sm text-white/70 space-y-1">{description}</div>
        <div>
          <label className="text-[10px] uppercase tracking-wider text-white/40">Reason (recorded in the audit log)</label>
          <input
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="e.g. user paid via UPI — receipt attached"
            autoFocus
            className="w-full mt-1 bg-[#13141a] border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-purple-500/50"
          />
        </div>
        <div className="flex gap-2 justify-end">
          <button onClick={onCancel} className="text-xs px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white/60 hover:text-white transition-all">
            Cancel
          </button>
          <button
            onClick={() => valid && onConfirm(reason.trim())}
            disabled={!valid || busy}
            className={`text-xs px-3 py-2 rounded-lg border transition-all disabled:opacity-40 ${
              danger
                ? 'bg-red-500/20 border-red-500/40 text-white/90 hover:bg-red-500/30'
                : 'bg-purple-500/25 border-purple-500/50 text-white/90 hover:bg-purple-500/35'
            }`}
          >
            {busy ? '…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
