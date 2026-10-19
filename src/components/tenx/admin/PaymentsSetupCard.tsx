// 10X RPC — Admin → Payments tab → "Payment Gateway Setup" card.
//
// Self-serve Razorpay credential management: view where the active keys come
// from (env vs dashboard override), paste fresh Key Id / Key Secret /
// Webhook Secret values, run a LIVE connection test (auth + order probe —
// the exact calls checkout makes), and reset back to the env values.
// Built so a "Could not start the payment" outage is fixable from here in
// under a minute, no redeploy needed.
'use client'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Card, PrimaryButton, GhostButton } from '../ui'
import { api, type AdminRazorpayConfig, type AdminRazorpayTestResult } from '@/lib/api-client'
import { fmtDateTime } from './shared'

type FieldName = 'keyId' | 'keySecret' | 'webhookSecret'

export function PaymentsSetupCard() {
  const [config, setConfig] = useState<AdminRazorpayConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [fields, setFields] = useState<Record<FieldName, string>>({ keyId: '', keySecret: '', webhookSecret: '' })
  const [touched, setTouched] = useState<Record<FieldName, boolean>>({ keyId: false, keySecret: false, webhookSecret: false })
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<AdminRazorpayTestResult | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      setConfig(await api.adminRazorpayGet())
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load payment settings')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const setField = (name: FieldName, value: string) => {
    setFields(f => ({ ...f, [name]: value }))
    setTouched(t => ({ ...t, [name]: true }))
  }

  const hasChanges = touched.keyId || touched.keySecret || touched.webhookSecret

  const save = async () => {
    if (!hasChanges) return
    setSaving(true)
    try {
      const patch: Record<FieldName, string> = {
        keyId: touched.keyId ? fields.keyId : undefined as unknown as string,
        keySecret: touched.keySecret ? fields.keySecret : undefined as unknown as string,
        webhookSecret: touched.webhookSecret ? fields.webhookSecret : undefined as unknown as string,
      }
      // Strip untouched fields so the backend keeps their stored values.
      const payload = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
      if (Object.keys(payload).length === 0) {
        toast.error('Nothing to save — edit a field first.')
        return
      }
      const res = await api.adminRazorpaySave(payload)
      setConfig(res)
      setFields({ keyId: '', keySecret: '', webhookSecret: '' })
      setTouched({ keyId: false, keySecret: false, webhookSecret: false })
      setTest(null) // stale result — keys changed
      toast.success('Payment credentials saved — run Test connection to verify.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const runTest = async () => {
    setTesting(true)
    try {
      const res = await api.adminRazorpayTest()
      setTest(res)
      if (res.ok) toast.success('Razorpay connection OK — checkout will work.')
      else toast.error(res.hint || 'Connection test failed — see details below.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Test failed')
    } finally {
      setTesting(false)
    }
  }

  const reset = async () => {
    if (!window.confirm('Remove the dashboard override and fall back to the Vercel env credentials?')) return
    try {
      const res = await api.adminRazorpayReset()
      setConfig(res)
      setTest(null)
      toast.success('Reset to environment credentials.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Reset failed')
    }
  }

  const modeChip = (mode: AdminRazorpayConfig['keyMode']) => {
    const map: Record<string, string> = {
      test: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
      live: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
      unknown: 'bg-red-500/15 text-red-300 border-red-500/30',
      none: 'bg-white/5 text-white/40 border-white/10',
    }
    return (
      <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border ${map[mode] || map.none}`}>
        {mode === 'test' ? 'Test Mode' : mode === 'live' ? 'Live Mode' : mode === 'unknown' ? 'Unrecognized key' : 'Not configured'}
      </span>
    )
  }

  const srcChip = (src: 'db' | 'env', label: string) => (
    <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border ${src === 'db' ? 'bg-purple-500/15 text-purple-300 border-purple-500/30' : 'bg-sky-500/15 text-sky-300 border-sky-500/30'}`}>
      {label}: {src === 'db' ? 'dashboard override' : 'env vars'}
    </span>
  )

  const inputCls = 'w-full bg-[#13141a] border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/25 focus:outline-none focus:border-purple-500/50 font-mono'

  return (
    <Card>
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <h3 className="font-bold text-white inline-flex items-center gap-2">
          Payment Gateway Setup
          {config && modeChip(config.keyMode)}
        </h3>
        <div className="flex items-center gap-2">
          <button
            onClick={runTest}
            disabled={testing || loading}
            className="text-[11px] text-white/90 bg-sky-500/10 border border-sky-500/30 px-2.5 py-1 rounded-lg hover:bg-sky-500/20 transition-all inline-flex items-center gap-1 disabled:opacity-40"
          >
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          {config?.source.keyId === 'db' && (
            <button
              onClick={reset}
              className="text-[11px] text-white/60 bg-white/5 border border-white/10 px-2.5 py-1 rounded-lg hover:text-white transition-all"
            >
              Use env vars
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-white/40 py-4 text-center">Loading payment settings…</p>
      ) : !config ? (
        <p className="text-sm text-red-300 py-4 text-center">Failed to load — refresh the page.</p>
      ) : (
        <div className="space-y-3">
          {/* Status row */}
          <div className="flex flex-wrap gap-1.5 items-center text-[11px] text-white/50">
            {srcChip(config.source.keyId, 'Key Id')}
            {srcChip(config.source.keySecret, 'Key Secret')}
            {srcChip(config.source.webhookSecret, 'Webhook')}
            <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border bg-white/5 text-white/40 border-white/10">
              configured: {config.configured ? 'yes' : 'NO'}
            </span>
            {config.overrideUpdatedAt && (
              <span>· override saved {fmtDateTime(config.overrideUpdatedAt)}</span>
            )}
          </div>

          {!config.configured && (
            <p className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
              No credentials resolved — checkout is disabled (503). Paste the Key Id + Key Secret below.
            </p>
          )}

          {/* Current values (masked) */}
          <div className="grid sm:grid-cols-3 gap-2 text-[11px]">
            <div className="glass-card-inner p-2.5">
              <p className="text-white/40 uppercase tracking-wider text-[9px] mb-1">Active Key Id</p>
              <p className="font-mono text-white/80 break-all">{config.keyId || '—'}</p>
            </div>
            <div className="glass-card-inner p-2.5">
              <p className="text-white/40 uppercase tracking-wider text-[9px] mb-1">Key Secret</p>
              <p className="font-mono text-white/80">{config.keySecretMasked || '—'}</p>
            </div>
            <div className="glass-card-inner p-2.5">
              <p className="text-white/40 uppercase tracking-wider text-[9px] mb-1">Webhook Secret</p>
              <p className="font-mono text-white/80">{config.webhookSecretMasked || '—'}</p>
            </div>
          </div>

          {/* Editable override fields */}
          <div className="grid sm:grid-cols-3 gap-2">
            <label className="block">
              <span className="text-[10px] uppercase tracking-wider text-white/40">Key Id {touched.keyId && '•'}</span>
              <input
                value={fields.keyId}
                onChange={e => setField('keyId', e.target.value)}
                placeholder={config.keyId || 'rzp_test_XXXXXXXX'}
                autoComplete="off"
                spellCheck={false}
                className={`${inputCls} mt-1`}
              />
            </label>
            <label className="block">
              <span className="text-[10px] uppercase tracking-wider text-white/40">Key Secret {touched.keySecret && '•'}</span>
              <input
                value={fields.keySecret}
                onChange={e => setField('keySecret', e.target.value)}
                placeholder={touched.keySecret ? '' : 'paste to replace'}
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                className={`${inputCls} mt-1`}
              />
            </label>
            <label className="block">
              <span className="text-[10px] uppercase tracking-wider text-white/40">Webhook Secret {touched.webhookSecret && '•'}</span>
              <input
                value={fields.webhookSecret}
                onChange={e => setField('webhookSecret', e.target.value)}
                placeholder={touched.webhookSecret ? '' : 'paste to replace'}
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                className={`${inputCls} mt-1`}
              />
            </label>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <PrimaryButton onClick={save} disabled={saving || !hasChanges} className="text-xs">
              {saving ? 'Saving…' : 'Save credentials'}
            </PrimaryButton>
            <GhostButton
              onClick={() => { setFields({ keyId: '', keySecret: '', webhookSecret: '' }); setTouched({ keyId: false, keySecret: false, webhookSecret: false }) }}
              disabled={!hasChanges || saving}
              className="text-xs"
            >
              Discard edits
            </GhostButton>
            <span className="text-[10px] text-white/30">Secrets are stored server-side and never shown again — only their last 4 characters.</span>
          </div>

          {/* Live test result */}
          {test && (
            <div className={`rounded-lg border p-3 text-xs space-y-1.5 ${test.ok ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-red-500/10 border-red-500/30'}`}>
              <p className={`font-bold ${test.ok ? 'text-emerald-300' : 'text-red-300'}`}>
                {test.ok ? '✓ Connection OK' : '✗ Connection failed'}
                <span className="ml-2 font-normal text-white/40">key mode: {test.keyMode}{test.keyIdSource ? ` · source: ${test.keyIdSource === 'db' ? 'dashboard' : 'env'}` : ''}</span>
              </p>
              <p className="text-white/60">
                Auth probe (GET /payments): <b className={test.auth.ok ? 'text-emerald-300' : 'text-red-300'}>{test.auth.ok ? `OK (HTTP ${test.auth.status})` : `FAILED (HTTP ${test.auth.status})`}</b>
                {test.auth.error ? ` — ${test.auth.error}` : ''}
              </p>
              {test.order && (
                <p className="text-white/60">
                  Order probe (POST /orders): <b className={test.order.ok ? 'text-emerald-300' : 'text-red-300'}>{test.order.ok ? `OK (HTTP ${test.order.status}, ${test.order.id})` : `FAILED (HTTP ${test.order.status})`}</b>
                  {test.order.error ? ` — ${test.order.error}` : ''}
                </p>
              )}
              {test.hint && <p className="text-white/50">{test.hint}</p>}
            </div>
          )}

          {/* Where-to-get-keys help */}
          <details className="text-[11px] text-white/50 group">
            <summary className="cursor-pointer hover:text-white/70 select-none">Where do I find these values?</summary>
            <div className="mt-2 space-y-1.5 pl-3 border-l border-white/10">
              <p>1. <b className="text-white/70">Key Id + Key Secret</b> — Razorpay Dashboard → <i>Settings → API Keys → Generate Test Mode Key</i> (or use an existing pair). Copy BOTH values together — they only work as a pair.</p>
              <p>2. <b className="text-white/70">Webhook Secret</b> — Razorpay Dashboard → <i>Settings → Webhooks → your webhook</i> ({config.webhookPath}). Only needed again if you rotated it.</p>
              <p>3. Save here, press <b className="text-white/70">Test connection</b>, and both probes must show OK. Then Buy Now works immediately — no redeploy.</p>
              <p className="text-white/30">Test Mode keys start with <code>rzp_test_</code> and simulate payments without moving money. Switch to <code>rzp_live_</code> keys only after KYC.</p>
            </div>
          </details>
        </div>
      )}
    </Card>
  )
}
