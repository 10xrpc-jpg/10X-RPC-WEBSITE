// 10X RPC — Admin → Settings tab → "Backend Nodes (24/7)" card.
//
// Self-serve management of the 24/7 daemon nodes: view the env list, add or
// replace nodes from the dashboard (no Vercel env change needed), probe any
// URL with a live /health check, and reveal the sync secret the nodes must
// carry in DAEMON_SYNC_SECRET.
'use client'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Card, PrimaryButton, GhostButton } from '../ui'
import { api, type AdminDaemonNodes } from '@/lib/api-client'
import { fmtDateTime } from './shared'
import { Eye, EyeOff, Copy, Activity } from 'lucide-react'

interface TestResult {
  ok: boolean
  url: string
  status?: number
  latencyMs?: number
  error?: string
  hint?: string
  health?: {
    service?: string | null
    uptimeSec?: number | null
    role?: string | null
    adopted?: string[] | null
    children?: Array<{ role?: string; isBase?: boolean; heartbeatAgeSec?: number | null; connected?: number | null }> | null
    daemonHeartbeatAgeSec?: number | null
    connected?: number | null
    trackedUsers?: number | null
  } | null
}

export function BackendNodesCard() {
  const [data, setData] = useState<AdminDaemonNodes | null>(null)
  const [loading, setLoading] = useState(true)
  const [urls, setUrls] = useState('')
  const [mode, setMode] = useState<'append' | 'replace'>('append')
  const [secret, setSecret] = useState('')
  const [secretTouched, setSecretTouched] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [test, setTest] = useState<TestResult | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const res = await api.adminDaemonNodesGet()
      setData(res)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load backend nodes')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const dirty = urls.trim().length > 0 || secretTouched

  const save = async () => {
    if (!dirty) return
    setSaving(true)
    try {
      const payload: { urls?: string; mode?: 'append' | 'replace'; syncSecret?: string } = {}
      if (urls.trim()) { payload.urls = urls; payload.mode = mode }
      if (secretTouched) payload.syncSecret = secret.trim()
      const res = await api.adminDaemonNodesSave(payload)
      setData(res)
      setUrls('')
      setSecret('')
      setSecretTouched(false)
      toast.success('Backend nodes saved — new syncs use this list immediately.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const reset = async () => {
    if (!window.confirm('Remove the dashboard override and fall back to the Vercel env node list?')) return
    try {
      const res = await api.adminDaemonNodesReset()
      setData(prev => ({ ...res, syncSecret: prev?.syncSecret ?? '', syncSecretMasked: res.syncSecretMasked, checkedAt: new Date().toISOString(), actor: '' }))
      toast.success('Reset to environment node list.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Reset failed')
    }
  }

  const probe = async (url: string) => {
    setTesting(url)
    setTest(null)
    try {
      const res = await api.adminDaemonNodesTest(url)
      setTest(res)
      if (res.ok) toast.success(`Node ${url} is healthy (${res.latencyMs}ms).`)
      else toast.error(res.hint || `Node ${url} failed the health check.`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Test failed')
    } finally {
      setTesting(null)
    }
  }

  const copySecret = async () => {
    if (!data?.syncSecret) return
    try {
      await navigator.clipboard.writeText(data.syncSecret)
      toast.success('Sync secret copied — set it as DAEMON_SYNC_SECRET on every node.')
    } catch {
      toast.error('Clipboard blocked — use the reveal toggle and copy manually.')
    }
  }

  const chip = (label: string, tone: 'green' | 'amber' | 'red' | 'gray') => {
    const tones = {
      green: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
      amber: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
      red: 'bg-red-500/15 text-red-300 border-red-500/30',
      gray: 'bg-white/5 text-white/40 border-white/10',
    }
    return <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border ${tones[tone]}`}>{label}</span>
  }

  return (
    <Card>
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <h3 className="font-bold text-white inline-flex items-center gap-2">
          Backend Nodes (24/7)
          {data && (data.effectiveBases.length > 0
            ? chip(`${data.effectiveBases.length} node${data.effectiveBases.length === 1 ? '' : 's'}`, 'green')
            : chip('none configured', 'red'))}
          {data?.override && chip(`override · ${data.override.mode}`, 'amber')}
        </h3>
        {data?.override && (
          <button onClick={reset} className="text-[11px] text-white/60 bg-white/5 border border-white/10 px-2.5 py-1 rounded-lg hover:text-white transition-all">
            Use env vars
          </button>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-white/40 py-4 text-center">Loading backend nodes…</p>
      ) : !data ? (
        <p className="text-sm text-red-300 py-4 text-center">Failed to load — refresh the page.</p>
      ) : (
        <div className="space-y-3">
          {/* Effective nodes */}
          <div className="space-y-1.5">
            {data.effectiveBases.length === 0 ? (
              <p className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
                No 24/7 nodes configured — presence runs in-process on this deployment (not 24/7). Add a node below after setting it up on your panel.
              </p>
            ) : data.effectiveBases.map(base => {
              const fromOverride = data.override?.urls.includes(base)
              return (
                <div key={base} className="flex items-center justify-between gap-2 bg-white/[0.03] border border-white/10 rounded-lg px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-xs font-mono text-white/80 truncate">{base}</p>
                    <p className="text-[10px] text-white/35">
                      {data.override && (fromOverride ? 'dashboard override' : 'env vars')}
                      {!data.override && 'env vars'}
                    </p>
                  </div>
                  <button
                    onClick={() => probe(base)}
                    disabled={testing !== null}
                    className="text-[11px] shrink-0 inline-flex items-center gap-1 bg-sky-500/10 border border-sky-500/30 text-white/90 px-2.5 py-1 rounded-lg hover:bg-sky-500/20 transition-all disabled:opacity-40"
                  >
                    <Activity className="w-3 h-3" />{testing === base ? 'Probing…' : 'Health check'}
                  </button>
                </div>
              )
            })}
          </div>

          {/* Sync secret */}
          <div className="glass-card-inner p-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <p className="text-[10px] uppercase tracking-wider text-white/40">Instant-sync secret</p>
                <p className="text-xs font-mono text-white/80 mt-0.5">{revealed ? (data.syncSecret || '(not configured)') : (data.syncSecretMasked || '(not configured)')}</p>
                <p className="text-[10px] text-white/35 mt-0.5">source: {data.syncSecretSource === 'db' ? 'dashboard override' : data.syncSecretSource === 'env' ? 'env vars' : 'none'}</p>
              </div>
              <div className="flex items-center gap-1.5">
                <button onClick={() => setRevealed(r => !r)} className="text-[11px] inline-flex items-center gap-1 bg-white/5 border border-white/10 text-white/70 px-2.5 py-1 rounded-lg hover:text-white transition-all">
                  {revealed ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}{revealed ? 'Hide' : 'Reveal'}
                </button>
                {data.syncSecret && (
                  <button onClick={copySecret} className="text-[11px] inline-flex items-center gap-1 bg-white/5 border border-white/10 text-white/70 px-2.5 py-1 rounded-lg hover:text-white transition-all">
                    <Copy className="w-3 h-3" />Copy
                  </button>
                )}
              </div>
            </div>
            <p className="text-[10px] text-white/35 mt-2">Every node must run with <code className="text-white/50">DAEMON_SYNC_SECRET=&lt;this value&gt;</code> — otherwise instant syncs get 403 (presence falls back to the 30s tick).</p>
          </div>

          {/* Add / replace nodes */}
          <div className="space-y-2">
            <label className="block">
              <span className="text-[10px] uppercase tracking-wider text-white/40">Node URLs — one per line (public allocation IP:port)</span>
              <textarea
                value={urls}
                onChange={e => setUrls(e.target.value)}
                rows={2}
                placeholder={'http://123.45.67.89:25613\nhttp://98.76.54.32:25677'}
                className="w-full mt-1 bg-[#13141a] border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder:text-white/25 focus:outline-none focus:border-purple-500/50 font-mono resize-y"
              />
            </label>
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex bg-white/5 border border-white/10 rounded-lg overflow-hidden">
                {(['append', 'replace'] as const).map(m => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    className={`text-[11px] px-3 py-1.5 capitalize transition-all ${mode === m ? 'bg-purple-500/25 text-white/90' : 'text-white/50 hover:text-white/80'}`}
                  >
                    {m === 'append' ? 'Add to env list' : 'Replace env list'}
                  </button>
                ))}
              </div>
              <PrimaryButton onClick={save} disabled={saving || !dirty} className="text-xs">
                {saving ? 'Saving…' : 'Save nodes'}
              </PrimaryButton>
              <GhostButton onClick={() => { setUrls(''); setSecret(''); setSecretTouched(false) }} disabled={!dirty || saving} className="text-xs">
                Discard edits
              </GhostButton>
            </div>
            <label className="block">
              <span className="text-[10px] uppercase tracking-wider text-white/40">Override sync secret (optional — only if you are rotating it)</span>
              <input
                value={secret}
                onChange={e => { setSecret(e.target.value); setSecretTouched(true) }}
                type="password"
                autoComplete="new-password"
                placeholder={secretTouched ? '' : `current: ${data.syncSecretMasked || 'none'}`}
                className="w-full mt-1 bg-[#13141a] border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder:text-white/25 focus:outline-none focus:border-purple-500/50 font-mono"
              />
            </label>
            {secretTouched && (
              <p className="text-[10px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
                After saving a new secret, set the SAME value as DAEMON_SYNC_SECRET on EVERY node — old nodes keep their env value otherwise.
              </p>
            )}
          </div>

          {/* Probe result */}
          {test && (
            <div className={`rounded-lg border p-3 text-xs space-y-1.5 ${test.ok ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-red-500/10 border-red-500/30'}`}>
              <p className={`font-bold ${test.ok ? 'text-emerald-300' : 'text-red-300'}`}>
                {test.ok ? '✓ Node healthy' : '✗ Node failed'}
                <span className="ml-2 font-normal text-white/40 font-mono">{test.url}{test.latencyMs != null ? ` · ${test.latencyMs}ms` : ''}</span>
              </p>
              {test.health && (
                <p className="text-white/60">
                  role: <b className="text-white/80">{test.health.role ?? '—'}</b>
                  {test.health.daemonHeartbeatAgeSec != null && <> · heartbeat: <b className={test.health.daemonHeartbeatAgeSec <= 180 ? 'text-emerald-300' : 'text-amber-300'}>{test.health.daemonHeartbeatAgeSec}s</b></>}
                  {test.health.trackedUsers != null && <> · tracked users: <b className="text-white/80">{test.health.trackedUsers}</b></>}
                  {test.health.adopted && test.health.adopted.length > 0 && <> · adopted: <b className="text-white/80">{test.health.adopted.join(', ')}</b></>}
                </p>
              )}
              {test.hint && <p className="text-white/50">{test.hint}</p>}
            </div>
          )}

          <details className="text-[11px] text-white/50 group">
            <summary className="cursor-pointer hover:text-white/70 select-none">How do I set up a new node?</summary>
            <div className="mt-2 space-y-1.5 pl-3 border-l border-white/10">
              <p>1. On your hosting panel (e.g. panel.softhost.net): create/reuse a Node.js server, upload the <b className="text-white/70">node kit</b> (GitHub → Actions → "Build node kit" → download artifact) into the server root and Extract.</p>
              <p>2. Edit <code className="text-white/50">.env</code> in the panel file editor: paste your database URL (DATABASE_URL + DATABASE_URL_UNPOOLED) and set DAEMON_ROLE (status / rpc / game / all). Copy the sync secret above into DAEMON_SYNC_SECRET.</p>
              <p>3. Start the server — first boot installs dependencies and generates the Prisma client automatically (watch the console).</p>
              <p>4. Copy the server's public allocation URL (Panel → Network → primary IP:port) and add it above → Save nodes → Health check must be green.</p>
            </div>
          </details>
        </div>
      )}
    </Card>
  )
}
