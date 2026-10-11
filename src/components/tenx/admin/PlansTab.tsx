// 10X RPC — admin Plans tab: create / edit / toggle / archive / delete the
// subscription plans. Everything the pricing page + checkout sell comes from
// this catalog (DB-backed): price, duration, badge, features, visibility and
// display order. Toggling active/visible re-prices the public page instantly
// — paid entitlements already granted are never touched (Payment rows keep
// their checkout-time snapshots).
'use client'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api, type AdminPlan, type AdminPlanInput } from '@/lib/api-client'
import { Card } from '../ui'
import { ConfirmDialog, Chip, StatCard, Toggle, rupees, fmtRel } from './shared'

const BLANK: AdminPlanInput & { slug: string } = {
  slug: '', name: '', description: '', amount: 19900, originalAmount: null,
  durationDays: 30, badge: '', features: [], active: true, visible: true, displayOrder: 10,
}

export function PlansTab() {
  const [plans, setPlans] = useState<AdminPlan[]>([])
  const [loading, setLoading] = useState(true)
  const [editor, setEditor] = useState<{ mode: 'create' } | { mode: 'edit'; plan: AdminPlan } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<AdminPlan | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.adminPlans()
      setPlans(res.plans)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load plans')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const totalRevenue = plans.reduce((a, p) => a + p.revenuePaise, 0)
  const totalSubs = plans.reduce((a, p) => a + p.subscribers, 0)

  const patch = async (plan: AdminPlan, data: Partial<AdminPlanInput>, okMsg: string) => {
    try {
      await api.adminPlanUpdate(plan.id, data)
      toast.success(okMsg)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Update failed')
    }
  }

  const toggle = async (plan: AdminPlan, field: 'active' | 'visible') => {
    const turningOff = plan[field]
    if (field === 'active' && turningOff && !window.confirm(`Disable "${plan.name}"? Checkout will reject it immediately (existing subscribers keep their time).`)) return
    if (field === 'visible' && turningOff && !window.confirm(`Hide "${plan.name}" from the pricing page? Checkout still accepts it via direct links.`)) return
    await patch(plan, { [field]: !turningOff }, `"${plan.name}" ${field === 'active' ? (turningOff ? 'disabled' : 'enabled') : turningOff ? 'hidden' : 'shown'}`)
  }

  const doDelete = async (reason: string) => {
    if (!confirmDelete) return
    setBusy(true)
    try {
      await api.adminPlanDelete(confirmDelete.id)
      toast.success(`Plan "${confirmDelete.name}" deleted`)
      setConfirmDelete(null)
      load()
    } catch (e) {
      // In-use plans are rejected server-side — surface the archive hint.
      toast.error(e instanceof Error ? e.message : 'Delete failed', { duration: 6000 })
      setConfirmDelete(null)
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <Card><p className="text-sm text-white/40 text-center py-6">Loading plans…</p></Card>

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <StatCard label="Plans" value={plans.filter(p => !p.archived).length} color="text-red-300" />
        <StatCard label="Active" value={plans.filter(p => p.active && !p.archived).length} color="text-green-400" />
        <StatCard label="Subscribers" value={totalSubs} color="text-sky-400" />
        <StatCard label="Revenue" value={rupees(totalRevenue)} color="text-amber-300" />
      </div>

      <Card>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold text-white">Plan Catalog</h3>
          <button
            onClick={() => setEditor({ mode: 'create' })}
            className="text-xs px-3 py-1.5 rounded-lg bg-purple-500/20 border border-purple-500/40 text-red-200 hover:bg-purple-500/30 transition-all"
          >
            + New Plan
          </button>
        </div>

        {plans.length === 0 ? (
          <p className="text-sm text-white/40 text-center py-6">No plans yet — create one (plus/pro are seeded automatically on first load).</p>
        ) : (
          <div className="space-y-2 max-h-[60vh] overflow-y-auto styled-scroll">
            {plans.map(p => (
              <div key={p.id} className={`glass-card-inner p-3 ${p.archived ? 'opacity-50' : ''}`}>
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="flex-1 min-w-[160px]">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-bold text-white">{p.name}</span>
                      <span className="text-[10px] font-mono text-white/30">{p.slug}</span>
                      {p.badge && <Chip tone="amber">{p.badge}</Chip>}
                      {p.archived && <Chip tone="gray">ARCHIVED</Chip>}
                      {!p.active && !p.archived && <Chip tone="red">DISABLED</Chip>}
                      {p.active && !p.visible && !p.archived && <Chip tone="sky">hidden</Chip>}
                    </div>
                    <p className="text-[11px] text-white/40 mt-0.5">
                      {rupees(p.amount)}{p.originalAmount ? <s className="ml-1 text-white/25">{rupees(p.originalAmount)}</s> : null} · {p.durationDays}d · order {p.displayOrder} · {p.features.length} features
                    </p>
                  </div>
                  <div className="text-right text-[11px] text-white/50">
                    <p>{p.subscribers} subs · {p.paidCount} sold</p>
                    <p className="text-amber-300/80">{rupees(p.revenuePaise)}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Toggle checked={p.active} onChange={() => toggle(p, 'active')} label={`Toggle ${p.name} active`} />
                    <Toggle checked={p.visible} onChange={() => toggle(p, 'visible')} label={`Toggle ${p.name} visible`} />
                    {!p.archived && (
                      <button onClick={() => setEditor({ mode: 'edit', plan: p })} className="text-[11px] px-2 py-1 rounded-lg bg-white/5 border border-white/10 text-white/70 hover:text-white transition-all">
                        Edit
                      </button>
                    )}
                    {!p.archived && (
                      <button
                        onClick={() => patch(p, { archived: true }, `"${p.name}" archived — hidden everywhere, history intact`)}
                        className="text-[11px] px-2 py-1 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 hover:bg-amber-500/20 transition-all"
                      >
                        Archive
                      </button>
                    )}
                    {p.archived && (
                      <button
                        onClick={() => patch(p, { archived: false }, `"${p.name}" restored`)}
                        className="text-[11px] px-2 py-1 rounded-lg bg-white/5 border border-white/10 text-white/70 hover:text-white transition-all"
                      >
                        Restore
                      </button>
                    )}
                    <button
                      onClick={() => setConfirmDelete(p)}
                      disabled={p.subscribers > 0 || p.paidCount > 0}
                      title={p.subscribers > 0 || p.paidCount > 0 ? 'In use — archive instead' : 'Delete permanently'}
                      className="text-[11px] px-2 py-1 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 hover:bg-red-500/20 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      ✕
                    </button>
                  </div>
                </div>
                <p className="text-[10px] text-white/25 mt-1">updated {fmtRel(p.updatedAt)}</p>
              </div>
            ))}
          </div>
        )}
        <p className="text-[10px] text-white/30 mt-3">
          Toggles: first switch = purchasable (active), second = shown on the pricing page (visible).
          Deleting is blocked while payments/subscriptions reference the plan — archive keeps history intact.
        </p>
      </Card>

      {editor && (
        <PlanEditor
          mode={editor.mode}
          plan={editor.mode === 'edit' ? editor.plan : null}
          onClose={() => setEditor(null)}
          onSaved={() => { setEditor(null); load() }}
        />
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title={`Delete plan "${confirmDelete?.name ?? ''}"?`}
        description={<>This permanently removes the plan. Only possible when no payment or subscription references it — otherwise archive it instead.</>}
        confirmLabel="Delete plan"
        danger
        busy={busy}
        onConfirm={doDelete}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  )
}

function PlanEditor({ mode, plan, onClose, onSaved }: {
  mode: 'create' | 'edit'
  plan: AdminPlan | null
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<AdminPlanInput & { slug: string; featuresText: string }>({
    slug: plan?.slug ?? '',
    name: plan?.name ?? '',
    description: plan?.description ?? '',
    amount: plan?.amount ?? 19900,
    originalAmount: plan?.originalAmount ?? null,
    durationDays: plan?.durationDays ?? 30,
    badge: plan?.badge ?? '',
    features: plan?.features ?? [],
    featuresText: (plan?.features ?? []).join('\n'),
    active: plan?.active ?? true,
    visible: plan?.visible ?? true,
    displayOrder: plan?.displayOrder ?? 10,
  })
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm(f => ({ ...f, [k]: v }))

  const save = async () => {
    if (!form.name.trim()) { toast.error('Name is required'); return }
    const amount = Math.round(Number(form.amount))
    if (!Number.isFinite(amount) || amount < 0) { toast.error('Invalid price'); return }
    const durationDays = Math.round(Number(form.durationDays))
    if (!Number.isFinite(durationDays) || durationDays < 1) { toast.error('Duration must be ≥ 1 day'); return }
    const features = form.featuresText.split('\n').map(s => s.trim()).filter(Boolean)
    setBusy(true)
    try {
      const payload: AdminPlanInput = {
        name: form.name.trim(),
        description: form.description?.trim() || null,
        amount,
        originalAmount: form.originalAmount ? Math.round(Number(form.originalAmount)) : null,
        durationDays,
        badge: form.badge?.trim() || null,
        features,
        active: form.active,
        visible: form.visible,
        displayOrder: Math.round(Number(form.displayOrder)) || 0,
      }
      if (mode === 'create') {
        const slug = form.slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '')
        if (!slug) { toast.error('Slug is required (e.g. plus, pro, ultimate)'); setBusy(false); return }
        await api.adminPlanCreate({ ...payload, slug })
        toast.success(`Plan "${payload.name}" created`)
      } else if (plan) {
        await api.adminPlanUpdate(plan.id, payload)
        toast.success(`Plan "${payload.name}" updated`)
      }
      onSaved()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed', { duration: 6000 })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-3" role="dialog" aria-modal="true" aria-label={mode === 'create' ? 'Create plan' : 'Edit plan'}>
      <div className="glass-card-inner w-full max-w-lg p-4 space-y-3 max-h-[88vh] overflow-y-auto styled-scroll">
        <div className="flex items-center justify-between">
          <h4 className="font-bold text-white">{mode === 'create' ? 'New Plan' : `Edit — ${plan?.name}`}</h4>
          <button onClick={onClose} aria-label="Close editor" className="text-white/40 hover:text-white text-sm px-2">✕</button>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Field label="Name">
            <input value={form.name} onChange={e => set('name', e.target.value)} placeholder="Plus (1 Month)" className={inputCls} />
          </Field>
          <Field label="Slug (URL id)">
            <input value={form.slug} onChange={e => set('slug', e.target.value)} disabled={mode === 'edit'} placeholder="plus" className={`${inputCls} disabled:opacity-40 font-mono`} />
          </Field>
        </div>

        <Field label="Description (optional)">
          <input value={form.description ?? ''} onChange={e => set('description', e.target.value)} placeholder="Everything in Free, plus…" className={inputCls} />
        </Field>

        <div className="grid grid-cols-3 gap-2">
          <Field label="Price ₹ (paise ×100)">
            <input type="number" min={0} value={form.amount / 100} onChange={e => set('amount', Math.round(Number(e.target.value) * 100))} className={inputCls} />
          </Field>
          <Field label="Was ₹ (optional)">
            <input type="number" min={0} value={form.originalAmount != null ? form.originalAmount / 100 : ''} onChange={e => set('originalAmount', e.target.value === '' ? null : Math.round(Number(e.target.value) * 100))} className={inputCls} />
          </Field>
          <Field label="Duration (days)">
            <input type="number" min={1} max={3650} value={form.durationDays} onChange={e => set('durationDays', Number(e.target.value))} className={inputCls} />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Field label="Badge (optional)">
            <input value={form.badge ?? ''} onChange={e => set('badge', e.target.value)} placeholder="20% OFF / BEST VALUE" className={inputCls} />
          </Field>
          <Field label="Display order">
            <input type="number" value={form.displayOrder} onChange={e => set('displayOrder', Number(e.target.value))} className={inputCls} />
          </Field>
        </div>

        <Field label="Features (one per line)">
          <textarea
            value={form.featuresText}
            onChange={e => set('featuresText', e.target.value)}
            rows={4}
            placeholder={'Full feature access\nPriority support'}
            className={`${inputCls} resize-none`}
          />
        </Field>

        <div className="flex items-center gap-4 text-xs text-white/70">
          <label className="flex items-center gap-2">
            <Toggle checked={form.active ?? true} onChange={v => set('active', v)} label="Active" /> Active (purchasable)
          </label>
          <label className="flex items-center gap-2">
            <Toggle checked={form.visible ?? true} onChange={v => set('visible', v)} label="Visible" /> Visible on pricing
          </label>
        </div>

        <div className="flex gap-2 justify-end pt-1">
          <button onClick={onClose} className="text-xs px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white/60 hover:text-white transition-all">Cancel</button>
          <button
            onClick={save}
            disabled={busy}
            className="text-xs px-4 py-2 rounded-lg bg-purple-500/25 border border-purple-500/50 text-red-100 hover:bg-purple-500/35 transition-all disabled:opacity-40"
          >
            {busy ? 'Saving…' : mode === 'create' ? 'Create plan' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

const inputCls = 'w-full bg-[#13141a] border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-purple-500/50'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wider text-white/40">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  )
}
