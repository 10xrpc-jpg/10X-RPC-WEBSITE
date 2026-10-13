// 10X RPC — admin Trials tab: the trial POLICY (DB-backed, applies to new
// signups the moment it is saved) + the live trial roster (who is trialing,
// who expired, who converted) with per-user actions routed through the
// SubscriptionModal.
'use client'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api, type AdminSubUser, type AdminSubscriptionsResponse, type AdminTrialConfig } from '@/lib/api-client'
import { Card } from '../ui'
import { Chip, ConfirmDialog, StatCard, SubStateBadge, Toggle, fmtDateTime } from './shared'
import { SubscriptionModal } from './SubscriptionModal'

export function TrialsTab() {
  const [config, setConfig] = useState<AdminTrialConfig | null>(null)
  const [stats, setStats] = useState<{ trialing: number; expired: number; converted: number } | null>(null)
  const [roster, setRoster] = useState<AdminSubUser[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [confirmSave, setConfirmSave] = useState(false)
  const [saveReason, setSaveReason] = useState('')
  const [detailId, setDetailId] = useState<string | null>(null)
  // editable form
  const [enabled, setEnabled] = useState(true)
  const [days, setDays] = useState(3)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [featuresText, setFeaturesText] = useState('')
  const [allowRepeat, setAllowRepeat] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [cfg, subs] = await Promise.all([
        api.adminTrialConfig(),
        api.adminSubscriptions({ status: 'trialing', sort: 'expiry', pageSize: 50 }),
      ])
      setConfig(cfg.config)
      setStats(cfg.stats)
      setEnabled(cfg.config.enabled)
      setDays(cfg.config.days)
      setName(cfg.config.name)
      setDescription(cfg.config.description)
      setFeaturesText(cfg.config.features.join('\n'))
      setAllowRepeat(cfg.config.allowRepeat)
      setRoster(subs.users)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load trial config')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const save = async (reason: string) => {
    setSaving(true)
    try {
      const res = await api.adminTrialConfigUpdate({
        enabled,
        days: Math.round(Number(days)),
        name: name.trim(),
        description: description.trim(),
        features: featuresText.split('\n').map(s => s.trim()).filter(Boolean),
        allowRepeat,
        reason,
      })
      setConfig(res.config)
      toast.success('Trial policy saved — applies to NEW signups immediately')
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed', { duration: 6000 })
    } finally {
      setSaving(false)
      setConfirmSave(false)
      setSaveReason('')
    }
  }

  const dirty = config && (
    config.enabled !== enabled || config.days !== Math.round(Number(days)) ||
    config.name !== name.trim() || config.description !== description.trim() ||
    config.allowRepeat !== allowRepeat ||
    JSON.stringify(config.features) !== JSON.stringify(featuresText.split('\n').map(s => s.trim()).filter(Boolean))
  )

  if (loading) return <Card><p className="text-sm text-white/40 text-center py-6">Loading trial config…</p></Card>

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2">
        <StatCard label="Trialing now" value={stats?.trialing ?? 0} color="text-red-300" />
        <StatCard label="Expired trials" value={stats?.expired ?? 0} color="text-red-300" />
        <StatCard label="Trial → paid" value={stats?.converted ?? 0} color="text-green-400" />
      </div>

      <Card>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold text-white">Trial Policy</h3>
          <button
            onClick={() => setConfirmSave(true)}
            disabled={!dirty || saving}
            className="text-xs px-3 py-1.5 rounded-lg bg-purple-500/20 border border-purple-500/40 text-white/90 hover:bg-purple-500/30 transition-all disabled:opacity-30"
          >
            {saving ? 'Saving…' : 'Save policy'}
          </button>
        </div>

        <div className="space-y-3 text-sm">
          <label className="flex items-center justify-between gap-3">
            <span className="text-white/70">Free trials enabled</span>
            <Toggle checked={enabled} onChange={setEnabled} label="Enable free trials" />
          </label>
          <p className="text-[10px] text-white/30 -mt-2">
            When off, brand-new accounts start SUSPENDED (no trial) — they must purchase to use 24/7 RPC.
          </p>

          <label className="block">
            <span className="text-[10px] uppercase tracking-wider text-white/40">Trial length (days, 0–90)</span>
            <input
              type="number" min={0} max={90} value={days}
              onChange={e => setDays(Number(e.target.value))}
              className="w-full mt-1 bg-[#13141a] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500/50"
            />
          </label>

          <label className="block">
            <span className="text-[10px] uppercase tracking-wider text-white/40">Trial plan name (pricing page)</span>
            <input value={name} onChange={e => setName(e.target.value)} className="w-full mt-1 bg-[#13141a] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500/50" />
          </label>

          <label className="block">
            <span className="text-[10px] uppercase tracking-wider text-white/40">Description</span>
            <input value={description} onChange={e => setDescription(e.target.value)} className="w-full mt-1 bg-[#13141a] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500/50" />
          </label>

          <label className="block">
            <span className="text-[10px] uppercase tracking-wider text-white/40">Features shown on the card (one per line)</span>
            <textarea
              value={featuresText}
              onChange={e => setFeaturesText(e.target.value)}
              rows={3}
              className="w-full mt-1 bg-[#13141a] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500/50 resize-none"
            />
          </label>

          <label className="flex items-center justify-between gap-3">
            <span className="text-white/70">Allow admins to grant repeat trials <span className="text-white/35">(users who already used theirs)</span></span>
            <Toggle checked={allowRepeat} onChange={setAllowRepeat} label="Allow repeat trials" />
          </label>

          <p className="text-[10px] text-white/30">
            Changes apply to NEW signups only — existing trials keep their end date (adjust per user below).
            Signup trials can never be self-reclaimed: the flag is set at signup, and only admins grant more.
          </p>
        </div>
      </Card>

      <Card>
        <h3 className="font-bold text-white mb-3">Trial Roster ({roster.length})</h3>
        <div className="space-y-2 max-h-[40vh] overflow-y-auto styled-scroll">
          {roster.length === 0 ? (
            <p className="text-sm text-white/40 text-center py-6">No active trials right now.</p>
          ) : roster.map(u => (
            <button key={u.id} onClick={() => setDetailId(u.id)} className="glass-card-inner p-2.5 w-full text-left hover:border-purple-500/30 transition-all">
              <div className="flex items-center gap-3">
                <img src={u.avatar} alt={u.username} className="w-8 h-8 rounded-full" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm text-white truncate">{u.username}</span>
                    <SubStateBadge sub={u.subscription} isAdmin={u.isAdmin} />
                  </div>
                  <p className="text-[10px] text-white/35">
                    trial ends {fmtDateTime(u.subscription.endsAt)}
                  </p>
                </div>
                <span className="text-white/30 text-[11px] shrink-0">Manage ▸</span>
              </div>
            </button>
          ))}
        </div>
        <p className="text-[10px] text-white/30 mt-3">
          Extend / reduce / revoke trials per user from the subscription modal (Actions → time + trial controls).
        </p>
      </Card>

      <ConfirmDialog
        open={confirmSave}
        title="Save trial policy?"
        description={
          <>
            New signups will get <b>{enabled ? `${Math.round(Number(days)) || 0}-day` : 'NO'}</b> free trial{enabled && Number(days) !== config?.days ? <> (was {config?.days})</> : null}.
            {enabled === false && <> Existing trials are untouched; new accounts start suspended.</>}
          </>
        }
        confirmLabel="Save policy"
        onConfirm={save}
        onCancel={() => setConfirmSave(false)}
        busy={saving}
      />

      {detailId && (
        <SubscriptionModal userId={detailId} onClose={() => setDetailId(null)} onChanged={() => load()} />
      )}
    </div>
  )
}
