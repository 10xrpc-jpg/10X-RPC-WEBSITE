// 10X RPC — admin SubscriptionModal: per-user subscription management.
// Shows the full picture (plan, status, start/expiry, remaining days, last
// payment, admin note) and exposes every privileged action behind the
// reason-required ConfirmDialog: add/subtract days, exact expiry, plan
// changes, grants, trials, suspend / reactivate / expire / cancel, note.
// Optimistic concurrency: actions carry the updatedAt the admin saw — the
// backend returns 409 when the row changed underneath (another admin or the
// sweep), and the modal refreshes instead of overwriting.
'use client'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api, type AdminUserDetail, type AdminAdjustAction } from '@/lib/api-client'
import { Chip, ConfirmDialog, SubStateBadge, Toggle, fmtDateTime, fmtRel, fmtUntil, planLabel, rupees } from './shared'

interface Pending {
  action: AdminAdjustAction
  title: string
  description: React.ReactNode
  confirmLabel: string
  danger?: boolean
  days?: number
  date?: string
  plan?: string
  note?: string
}

export function SubscriptionModal({ userId, onClose, onChanged }: {
  userId: string
  onClose: () => void
  onChanged?: () => void
}) {
  const [detail, setDetail] = useState<AdminUserDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<'sub' | 'payments' | 'history'>('sub')
  // form state for day/date inputs
  const [daysInput, setDaysInput] = useState('10')
  const [expiryInput, setExpiryInput] = useState('')
  const [startInput, setStartInput] = useState('')
  const [planInput, setPlanInput] = useState('')
  const [noteInput, setNoteInput] = useState('')

  const load = useCallback(async () => {
    try {
      const d = await api.adminUserDetail(userId)
      setDetail(d)
      if (d.subscription?.raw.currentPeriodEnd ?? d.subscription?.raw.trialEndsAt) {
        const iso = d.subscription!.raw.currentPeriodEnd ?? d.subscription!.raw.trialEndsAt ?? ''
        setExpiryInput(toLocalInput(iso))
      }
      setStartInput(toLocalInput(d.subscription?.raw.createdAt ?? d.user.createdAt))
      setPlanInput(d.subscription?.plan ?? 'plus')
      setNoteInput(d.user.adminNote ?? '')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load user')
    } finally {
      setLoading(false)
    }
  }, [userId])

  useEffect(() => { load() }, [load])

  const run = async (reason: string) => {
    if (!pending) return
    setBusy(true)
    try {
      const res = await api.adminSubscriptionAdjust({
        userId,
        action: pending.action,
        reason,
        days: pending.days,
        date: pending.date,
        plan: pending.plan,
        note: pending.note,
        expectedUpdatedAt: detail?.subscription?.raw.updatedAt,
      })
      toast.success(res.message, { duration: 5000 })
      setPending(null)
      await load()
      onChanged?.()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Action failed'
      toast.error(msg, { duration: 6000 })
      if (msg.includes('changed while you were editing') || msg.includes('conflict')) {
        await load() // 409 — refresh the row the admin is looking at
        setPending(null)
      }
    } finally {
      setBusy(false)
    }
  }

  const u = detail?.user
  const s = detail?.subscription
  const raw = s?.raw

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75 backdrop-blur-sm p-3" role="dialog" aria-modal="true" aria-label={`Manage subscription — ${u?.username ?? ''}`}>
      <div className="glass-card-inner w-full max-w-xl p-4 space-y-3 max-h-[90vh] overflow-y-auto styled-scroll">
        {/* header */}
        <div className="flex items-start gap-3">
          {u && <img src={u.avatar} alt={u.username} className="w-11 h-11 rounded-full" />}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-bold text-white">{u?.username ?? '…'}</span>
              {u?.isAdmin && <Chip tone="amber">ADMIN</Chip>}
            </div>
            <p className="text-[11px] text-white/40 font-mono">{u?.discordId}</p>
            <p className="text-[11px] text-white/30">joined {u ? fmtDateTime(u.createdAt) : '—'}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-white/40 hover:text-white text-sm px-2">✕</button>
        </div>

        {/* tabs */}
        <div className="flex gap-1 border-b border-white/10">
          {(['sub', 'payments', 'history'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`text-[11px] px-3 py-2 border-b-2 transition-all ${tab === t ? 'border-purple-400 text-white' : 'border-transparent text-white/45 hover:text-white/80'}`}
            >
              {t === 'sub' ? 'Subscription' : t === 'payments' ? `Payments${detail ? ` (${detail.payments.length})` : ''}` : `History${detail ? ` (${detail.audits.length})` : ''}`}
            </button>
          ))}
        </div>

        {loading ? (
          <p className="text-sm text-white/40 text-center py-8">Loading…</p>
        ) : !detail ? (
          <p className="text-sm text-white/40 text-center py-8">User unavailable.</p>
        ) : tab === 'sub' ? (
          <>
            {/* subscription summary */}
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3 space-y-2 text-sm">
              {!s ? (
                <p className="text-white/50">No subscription row yet — it is created on the user&apos;s next visit. Grant a plan to create it now.</p>
              ) : (
                <>
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-white">{planLabel(s.plan)}</span>
                      <SubStateBadge sub={s} isAdmin={u?.isAdmin} />
                      {raw?.trialUsed && <Chip tone="gray">trial used</Chip>}
                    </div>
                    <span className="text-xs text-white/50">
                      {s.neverExpires && s.status === 'active' ? 'never expires' : s.status === 'suspended' ? 'access stopped' : `${fmtUntil(s.endsAt)}`}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-white/50">
                    <span>Created: <b className="text-white/75 font-normal">{fmtDateTime(raw?.createdAt)}</b></span>
                    <span>Updated: <b className="text-white/75 font-normal">{fmtDateTime(raw?.updatedAt)}</b></span>
                    <span>Trial ends: <b className="text-white/75 font-normal">{fmtDateTime(raw?.trialEndsAt)}</b></span>
                    <span>Period ends: <b className="text-white/75 font-normal">{fmtDateTime(raw?.currentPeriodEnd)}</b></span>
                    <span>Suspended: <b className="text-white/75 font-normal">{fmtDateTime(raw?.suspendedAt)}</b></span>
                    <span>Days left: <b className="text-white/75 font-normal">{s.neverExpires ? '∞' : s.daysLeft}</b></span>
                  </div>
                  {detail.payments[0] && (
                    <p className="text-[11px] text-white/40 border-t border-white/5 pt-1.5">
                      Last payment: {detail.payments[0].planLabel ?? detail.payments[0].plan} · {rupees(detail.payments[0].amount)} · {detail.payments[0].status} · {fmtRel(detail.payments[0].createdAt)}
                    </p>
                  )}
                </>
              )}
            </div>

            {/* actions */}
            <div className="space-y-3">
              <ActionGroup title="Adjust time">
                <div className="flex gap-1.5 items-center flex-wrap">
                  <input
                    type="number"
                    value={daysInput}
                    onChange={e => setDaysInput(e.target.value)}
                    aria-label="Days"
                    className="w-20 bg-[#13141a] border border-white/10 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-purple-500/50"
                  />
                  <SmallBtn tone="green" onClick={() => askAddDays(1)}>+ add</SmallBtn>
                  <SmallBtn tone="red" onClick={() => askSubtractDays(1)}>− subtract</SmallBtn>
                  <span className="text-[10px] text-white/30 w-full sm:w-auto">quick:</span>
                  {[7, 30, 90].map(d => (
                    <SmallBtn key={d} tone="green" onClick={() => askAddDays(d)}>+{d}d</SmallBtn>
                  ))}
                </div>
              </ActionGroup>

              <ActionGroup title="Dates">
                <div className="space-y-1.5">
                  <div className="flex gap-1.5 items-center flex-wrap">
                    <input type="datetime-local" value={expiryInput} onChange={e => setExpiryInput(e.target.value)} aria-label="Expiry date" className="bg-[#13141a] border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-purple-500/50" />
                    <SmallBtn tone="purple" onClick={askSetExpiry}>Set expiry</SmallBtn>
                  </div>
                  <div className="flex gap-1.5 items-center flex-wrap">
                    <input type="datetime-local" value={startInput} onChange={e => setStartInput(e.target.value)} aria-label="Start date" className="bg-[#13141a] border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-purple-500/50" />
                    <SmallBtn tone="purple" onClick={askSetStart}>Set start</SmallBtn>
                  </div>
                </div>
              </ActionGroup>

              <ActionGroup title="Plan & trial">
                <div className="flex gap-1.5 items-center flex-wrap">
                  <select
                    value={planInput}
                    onChange={e => setPlanInput(e.target.value)}
                    aria-label="Plan"
                    className="bg-[#13141a] border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-purple-500/50"
                  >
                    {(detail.plans.length ? detail.plans : [{ slug: 'plus', name: 'Plus', amount: 0, durationDays: 30, active: true }]).map(p => (
                      <option key={p.slug} value={p.slug}>{p.name}{p.amount ? ` — ${rupees(p.amount)}/${p.durationDays}d` : ''}</option>
                    ))}
                    <option value="free">Free</option>
                    <option value="lifetime">Lifetime</option>
                  </select>
                  <SmallBtn tone="purple" onClick={askGrantPlan}>Grant / renew</SmallBtn>
                  <SmallBtn tone="purple" onClick={askSetPlan}>Change plan (keep dates)</SmallBtn>
                  <SmallBtn tone="violet" onClick={askGrantTrial}>Grant trial 3d</SmallBtn>
                </div>
              </ActionGroup>

              <ActionGroup title="Lifecycle">
                <div className="flex gap-1.5 flex-wrap">
                  <SmallBtn tone="red" onClick={askSuspend}>⛔ Suspend</SmallBtn>
                  <SmallBtn tone="green" onClick={askReactivate}>▶ Reactivate</SmallBtn>
                  <SmallBtn tone="red" onClick={askExpireNow}>Expire now</SmallBtn>
                  <SmallBtn tone="red" onClick={askCancel}>Cancel</SmallBtn>
                  <SmallBtn tone="purple" onClick={askClearExpiry}>Never expires</SmallBtn>
                </div>
              </ActionGroup>

              <ActionGroup title="Admin note (internal, never shown to the user)">
                <div className="flex gap-1.5 items-start">
                  <textarea
                    value={noteInput}
                    onChange={e => setNoteInput(e.target.value)}
                    rows={2}
                    placeholder="e.g. VIP — renewed manually on Discord"
                    className="flex-1 bg-[#13141a] border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white placeholder:text-white/30 focus:outline-none focus:border-purple-500/50 resize-none"
                  />
                  <SmallBtn tone="purple" onClick={askNote}>Save note</SmallBtn>
                </div>
              </ActionGroup>
            </div>
          </>
        ) : tab === 'payments' ? (
          <div className="space-y-2 max-h-[50vh] overflow-y-auto styled-scroll">
            {detail.payments.length === 0 ? (
              <p className="text-sm text-white/40 text-center py-6">No payments yet.</p>
            ) : detail.payments.map(p => (
              <div key={p.id} className="rounded-lg border border-white/10 bg-white/[0.03] p-2.5 flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-white/85">
                    {p.planLabel ?? p.plan} · <span className={p.status === 'paid' ? 'text-amber-300' : 'text-white/40'}>{rupees(p.amount)}</span>
                    {p.periodDays ? <span className="text-white/40"> · {p.periodDays}d</span> : null}
                  </p>
                  <p className="text-[10px] text-white/30 font-mono truncate">{p.orderId}{p.paymentId ? ` → ${p.paymentId}` : ''}</p>
                </div>
                <div className="text-right shrink-0">
                  <Chip tone={p.status === 'paid' ? 'green' : 'gray'}>{p.status.toUpperCase()}</Chip>
                  <p className="text-[10px] text-white/30 mt-0.5">{fmtRel(p.createdAt)}</p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-2 max-h-[50vh] overflow-y-auto styled-scroll">
            {detail.audits.length === 0 ? (
              <p className="text-sm text-white/40 text-center py-6">No recorded changes for this user yet.</p>
            ) : detail.audits.map(a => (
              <div key={a.id} className="rounded-lg border border-white/10 bg-white/[0.03] p-2.5">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-xs text-white/85 font-mono">{a.action}</span>
                  <span className="text-[10px] text-white/30">{fmtDateTime(a.createdAt)}</span>
                </div>
                {a.reason && <p className="text-[11px] text-white/50 mt-0.5">reason: {a.reason}</p>}
                <p className="text-[10px] text-white/30 mt-0.5">by {a.actorName ?? a.actorId} · {a.outcome}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {pending && (
        <ConfirmDialog
          open
          title={pending.title}
          description={pending.description}
          confirmLabel={pending.confirmLabel}
          danger={pending.danger}
          busy={busy}
          onConfirm={run}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  )

  // ---- action builders (each opens the reason dialog with exact change preview) ----
  function askAddDays(d?: number) {
    const n = d ?? Number(daysInput)
    if (!Number.isFinite(n) || n <= 0) { toast.error('Enter a positive number of days'); return }
    const target = s?.status === 'trialing' ? 'trial' : 'subscription'
    setPending({
      action: 'add_days', days: n,
      title: `Add ${n} day(s)?`,
      description: <><b>{u?.username}</b>&apos;s {target} end moves from <b>{fmtDateTime(s?.endsAt)}</b> to <b>{fmtDateTime(addDaysIso(s?.endsAt, n))}</b> ({daysLeftAfter(n)}d remaining).</>,
      confirmLabel: `Add ${n} day(s)`,
    })
  }

  function askSubtractDays(d?: number) {
    const n = d ?? Number(daysInput)
    if (!Number.isFinite(n) || n <= 0) { toast.error('Enter a positive number of days'); return }
    setPending({
      action: 'subtract_days', days: n,
      title: `Subtract ${n} day(s)?`,
      description: <><b>{u?.username}</b>&apos;s end moves from <b>{fmtDateTime(s?.endsAt)}</b> to <b>{fmtDateTime(addDaysIso(s?.endsAt, -n))}</b>. Crossing zero expires the account immediately.</>,
      confirmLabel: `Subtract ${n} day(s)`,
      danger: true,
    })
  }

  function askSetExpiry() {
    if (!expiryInput) { toast.error('Pick a date first'); return }
    const iso = new Date(expiryInput).toISOString()
    const future = new Date(expiryInput).getTime() > Date.now()
    setPending({
      action: 'set_expiry', date: iso,
      title: `Set expiry to ${fmtDateTime(iso)}?`,
      description: <><b>{u?.username}</b>&apos;s access {future ? <>runs until <b>{fmtDateTime(iso)}</b></> : <>ends immediately (the date is in the past)</>}. Start date is untouched.</>,
      confirmLabel: 'Set expiry',
      danger: !future,
    })
  }

  function askSetStart() {
    if (!startInput) { toast.error('Pick a date first'); return }
    const iso = new Date(startInput).toISOString()
    setPending({
      action: 'set_start', date: iso,
      title: 'Change subscription start date?',
      description: <>Recorded start becomes <b>{fmtDateTime(iso)}</b>. This is bookkeeping — expiry is not recalculated.</>,
      confirmLabel: 'Set start date',
    })
  }

  function askGrantPlan() {
    const slug = planInput
    const dbPlan = detail?.plans.find(p => p.slug === slug)
    const dur = dbPlan?.durationDays ?? 30
    const isRenewal = s?.status === 'suspended'
    setPending({
      action: 'grant_plan', plan: slug,
      title: `Grant ${planLabel(slug)}${dbPlan ? ` (${rupees(dbPlan.amount)} / ${dur}d)` : ''}?`,
      description: <><b>{u?.username}</b> gets {planLabel(slug)} for <b>{dur} days</b>{s && s.neverExpires === false && s.status === 'active' ? ' stacked on their remaining time' : ''}. {isRenewal ? 'This is an explicit renewal — the suspension is lifted.' : 'Suspension is lifted if present.'}</>,
      confirmLabel: `Grant ${planLabel(slug)}`,
    })
  }

  function askSetPlan() {
    const slug = planInput
    setPending({
      action: 'set_plan', plan: slug,
      title: `Change plan to ${planLabel(slug)}?`,
      description: <><b>{u?.username}</b>&apos;s plan becomes <b>{planLabel(slug)}</b>. Current dates are kept — expiry does not move.{slug === 'lifetime' ? ' Lifetime clears the expiry (never expires).' : ''}</>,
      confirmLabel: 'Change plan',
    })
  }

  function askGrantTrial() {
    setPending({
      action: 'grant_trial', days: 3,
      title: 'Grant a 3-day trial?',
      description: <><b>{u?.username}</b> gets a fresh 3-day free trial{raw?.trialUsed ? ' — note: they already used their signup trial (this is a manual admin grant)' : ''}. Marks the trial as used.</>,
      confirmLabel: 'Grant trial',
    })
  }

  function askSuspend() {
    setPending({
      action: 'suspend',
      title: `Suspend ${u?.username}?`,
      description: <>24/7 RPC stops immediately on every device. The recorded expiry date is <b>preserved</b> — reactivate restores access without changing dates.</>,
      confirmLabel: 'Suspend now', danger: true,
    })
  }

  function askReactivate() {
    setPending({
      action: 'reactivate',
      title: `Reactivate ${u?.username}?`,
      description: <>Lifts the suspension and restores access for the remaining time ({s?.daysLeft ?? 0}d). Only possible when real time is left — otherwise grant a plan.</>,
      confirmLabel: 'Reactivate',
    })
  }

  function askExpireNow() {
    setPending({
      action: 'expire_now',
      title: `Expire ${u?.username}'s subscription now?`,
      description: <>Remaining time is zeroed and the account is suspended with RPC killed everywhere. Dates in the audit log record the change.</>,
      confirmLabel: 'Expire now', danger: true,
    })
  }

  function askCancel() {
    setPending({
      action: 'cancel',
      title: `Cancel ${u?.username}'s subscription?`,
      description: <>Access stops now (suspended). Recorded as a cancellation in the audit log with your reason.</>,
      confirmLabel: 'Cancel subscription', danger: true,
    })
  }

  function askClearExpiry() {
    setPending({
      action: 'clear_expiry',
      title: 'Remove the expiry date?',
      description: <><b>{u?.username}</b>&apos;s current plan will never expire (until changed). Use for comped/lifetime-style access under the current plan.</>,
      confirmLabel: 'Remove expiry',
    })
  }

  function askNote() {
    setPending({
      action: 'add_note', note: noteInput,
      title: 'Save admin note?',
      description: <>Internal remark for this account: {noteInput ? `"${noteInput}"` : '(clears the note)'}</>,
      confirmLabel: 'Save note',
    })
  }

  function daysLeftAfter(n: number): number {
    if (!s || s.neverExpires) return Infinity
    const base = s.endsAt ? new Date(s.endsAt).getTime() : Date.now()
    return Math.max(0, Math.ceil((base - Date.now() + n * 86400000) / 86400000))
  }
}

function addDaysIso(iso: string | null | undefined, days: number): string {
  const base = iso ? new Date(iso).getTime() : Date.now()
  return new Date(base + days * 86400000).toISOString()
}

function toLocalInput(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function ActionGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-white/40 mb-1">{title}</p>
      {children}
    </div>
  )
}

function SmallBtn({ tone, onClick, children }: { tone: 'green' | 'red' | 'purple' | 'violet'; onClick: () => void; children: React.ReactNode }) {
  const tones: Record<string, string> = {
    green: 'bg-green-500/15 border-green-500/30 text-green-300 hover:bg-green-500/25',
    red: 'bg-red-500/10 border-red-500/30 text-red-300 hover:bg-red-500/20',
    purple: 'bg-purple-500/15 border-purple-500/30 text-purple-300 hover:bg-purple-500/25',
    violet: 'bg-fuchsia-500/15 border-fuchsia-500/30 text-fuchsia-300 hover:bg-fuchsia-500/25',
  }
  return (
    <button onClick={onClick} className={`text-[11px] px-2.5 py-1.5 rounded-lg border transition-all ${tones[tone]}`}>
      {children}
    </button>
  )
}
