// 10X RPC — Application RPC card (dashboard) — Task 90.
//
// The THIRD, fully independent RPC system's own control surface. Visual
// language matches the existing dashboard (glass-card, purple accents) but
// everything here talks ONLY to /api/application-rpc* — the Normal RPC slot
// forms, the Game RPC page and the Auto Rotate card are never read, written
// or re-rendered from this component's state.
//
// Honest status: the pill ALWAYS reflects the daemon-written runState
// (idle / starting / running / error + the exact backend error text). The UI
// never claims the RPC is running on its own — poll merges touch ONLY the
// status fields so in-progress edits can never be clobbered.
'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  api, type ApplicationRpcConfig, type ApplicationRunState,
} from '@/lib/api-client'
import { PurpleSwitch, Field, TextInput, PillSelect, PrimaryButton } from './ui'
import { RpcPlatformSelect } from './RpcPlatformSelect'
import { Blocks, ChevronDown, Check, Info, Loader2, CircleAlert } from 'lucide-react'

const APP_ID_RE = /^\d{15,21}$/

const TYPE_OPTIONS = [
  { value: 'PLAYING', label: 'Playing' },
  { value: 'STREAMING', label: 'Streaming' },
  { value: 'LISTENING', label: 'Listening' },
  { value: 'WATCHING', label: 'Watching' },
  { value: 'COMPETING', label: 'Competing' },
]

type AppLookupState =
  | { status: 'idle' }
  | { status: 'invalid' }
  | { status: 'checking' }
  | { status: 'found'; name: string; iconUrl: string | null }
  | { status: 'not_found' }

/** Run-state pill — mirrors the daemon-written execution truth. */
function runStatePill(state: ApplicationRunState): { label: string; className: string; pulse: boolean } {
  switch (state) {
    case 'running':
      return {
        label: 'Running',
        className: 'text-[#8ff0a4] border-[#23A559]/40 bg-[#23A559]/10',
        pulse: true,
      }
    case 'starting':
      return { label: 'Starting…', className: 'text-amber-200 border-amber-500/40 bg-amber-500/10', pulse: true }
    case 'error':
      return { label: 'Error', className: 'text-red-200 border-red-500/40 bg-red-500/10', pulse: false }
    default:
      return { label: 'Disabled', className: 'text-white/45 border-white/10 bg-white/5', pulse: false }
  }
}

function sinceLabel(iso: string | null): string | null {
  if (!iso) return null
  const at = new Date(iso).getTime()
  if (!Number.isFinite(at)) return null
  const secs = Math.max(0, Math.floor((Date.now() - at) / 1000))
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `for ${mins} min`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `for ${hours}h ${mins % 60}m`
  return `for ${Math.floor(hours / 24)}d ${hours % 24}h`
}

export function ApplicationRpcCard() {
  const [config, setConfig] = useState<ApplicationRpcConfig | null>(null)
  const [backend, setBackend] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [open, setOpen] = useState(false)
  const [appLookup, setAppLookup] = useState<AppLookupState>({ status: 'idle' })
  const platformRef = useRef<HTMLDivElement | null>(null)
  const [platformOpen, setPlatformOpen] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await api.applicationRpcGet()
      setConfig(res.config)
      setBackend(res.backend ?? null)
      return res.config
    } catch {
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // Poll ONLY the execution-status fields (never clobber in-progress edits).
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const res = await api.applicationRpcGet()
        setBackend(res.backend ?? null)
        setConfig(prev => (prev
          ? { ...prev, runState: res.config.runState, runError: res.config.runError, runSinceAt: res.config.runSinceAt, enabled: res.config.enabled }
          : res.config))
      } catch { /* transient — next poll retries */ }
    }, 15000)
    return () => clearInterval(t)
  }, [])

  // Application ID → official identity preview (debounced, same pattern as
  // the Normal RPC form; the save endpoint re-validates server-side).
  useEffect(() => {
    const raw = (config?.appId ?? '').trim()
    if (!APP_ID_RE.test(raw)) {
      setAppLookup(raw ? { status: 'invalid' } : { status: 'idle' })
      return
    }
    let cancelled = false
    setAppLookup({ status: 'checking' })
    const t = setTimeout(async () => {
      try {
        const r = await api.appLookup(raw)
        if (!cancelled) setAppLookup({ status: 'found', name: r.name, iconUrl: r.iconUrl })
      } catch {
        if (!cancelled) setAppLookup({ status: 'not_found' })
      }
    }, 700)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [config?.appId])

  // Close the platform dropdown on outside click.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (platformRef.current && !platformRef.current.contains(e.target as Node)) {
        setPlatformOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const patch = (p: Partial<ApplicationRpcConfig>) => setConfig(prev => (prev ? { ...prev, ...p } : prev))

  const handleToggle = async (next: boolean) => {
    if (toggling || !config) return
    setToggling(true)
    try {
      const res = await api.applicationRpcToggle(next)
      if (res.ok && res.config) {
        setConfig(res.config)
        toast.success(res.message || (next ? 'Application RPC enabled' : 'Application RPC disabled'), { duration: 2500 })
      } else {
        toast.error(res.message || 'Could not toggle Application RPC', { duration: 4000 })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not toggle Application RPC'
      toast.error(msg, { duration: 4000 })
    } finally {
      setToggling(false)
    }
  }

  const handleSave = async () => {
    if (saving || !config) return
    setSaving(true)
    try {
      const res = await api.applicationRpcSave({
        name: config.name,
        type: config.type,
        platform: config.platform,
        appId: config.appId ?? '',
        state: config.state,
        details: config.details,
        largeImage: config.largeImage,
        largeText: config.largeText,
        smallImage: config.smallImage,
        smallText: config.smallText,
        button1Label: config.button1Label,
        button1Url: config.button1Url,
        button2Label: config.button2Label,
        button2Url: config.button2Url,
        partyCurrent: config.partyCurrent,
        partyMax: config.partyMax,
        startMinsAgo: config.startMinsAgo,
        endTotalMins: config.endTotalMins,
      })
      if (res.ok && res.config) {
        setConfig(res.config)
        toast.success(res.message || 'Application RPC saved', { duration: 2500 })
      } else {
        toast.error(res.message || 'Failed to save Application RPC', { duration: 4500 })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to save Application RPC'
      toast.error(msg, { duration: 4500 })
    } finally {
      setSaving(false)
    }
  }

  const pill = runStatePill(config?.runState ?? 'idle')
  const since = sinceLabel(config?.runSinceAt ?? null)

  return (
    <div className="glass-card p-5 sm:p-6 shadow-2xl" data-testid="application-rpc-card">
      {/* Header — own switch, own state */}
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-xl sm:text-2xl font-bold text-white flex items-center gap-2">
          <Blocks className="w-6 h-6 text-purple-300" aria-hidden />
          Application RPC
        </h2>
        <PurpleSwitch
          checked={!!config?.enabled}
          onCheckedChange={handleToggle}
          ariaLabel="Application RPC"
        />
      </div>
      <p className="text-xs text-white/50 leading-relaxed">
        The third, fully independent RPC — runs under its own Discord Application ID with
        its own session, config and controls. Normal RPC and Game RPC are never touched.
      </p>

      {/* Own status strip — daemon-reported execution truth */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span
          data-testid="application-rpc-state"
          className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full ${pill.className}`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${pill.pulse ? 'animate-pulse bg-current' : 'bg-current'}`} aria-hidden />
          {pill.label}
        </span>
        {since && (config?.runState === 'running' || config?.runState === 'error') && (
          <span className="text-[11px] text-white/40">{since}</span>
        )}
        {backend === 'in-process' && (
          <span className="text-[11px] text-white/30">local engine</span>
        )}
      </div>
      {config?.runState === 'error' && config.runError && (
        <p className="mt-2 text-xs text-red-200/90 flex items-start gap-1.5" role="alert">
          <CircleAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden />
          {config.runError}
        </p>
      )}

      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="mt-4 w-full flex items-center justify-between rounded-xl bg-white/[0.03] border border-white/5 hover:border-white/15 px-4 py-3 text-sm text-white/70 hover:text-white transition-all cursor-pointer"
      >
        <span className="inline-flex items-center gap-2">
          <Info className="w-4 h-4 text-purple-300" aria-hidden />
          {open ? 'Hide Application RPC settings' : 'Open Application RPC settings'}
        </span>
        <ChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>

      {open && (
        loading ? (
          <div className="mt-4 flex items-center justify-center py-8 text-white/40 text-sm">
            <Loader2 className="w-5 h-5 animate-spin mr-2" aria-hidden /> Loading…
          </div>
        ) : config ? (
          <div className="mt-4 space-y-4">
            {/* Application ID — the identity this RPC presents as */}
            <Field
              label="Application ID"
              hint="Required to enable. The presence runs under this application's identity — find it in the Discord Developer Portal."
            >
              <TextInput
                inputMode="numeric"
                placeholder="e.g. 1556458074594738376"
                value={config.appId ?? ''}
                onChange={e => patch({ appId: e.target.value })}
                aria-label="Application ID"
              />
            </Field>
            {appLookup.status === 'checking' && (
              <p className="text-xs text-white/40 flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> Looking up application…</p>
            )}
            {appLookup.status === 'found' && (
              <div className="flex items-center gap-2.5 text-xs text-white/70">
                {appLookup.iconUrl
                  ? <img src={appLookup.iconUrl} alt="" className="w-6 h-6 rounded-md" />
                  : <span className="w-6 h-6 rounded-md bg-purple-500/20 inline-block" aria-hidden />}
                <span><Check className="w-3.5 h-3.5 inline text-[#8ff0a4] mr-1" aria-hidden />{appLookup.name}</span>
              </div>
            )}
            {appLookup.status === 'invalid' && (
              <p className="text-xs text-amber-200/90">Application IDs are 15–21 digit numbers.</p>
            )}
            {appLookup.status === 'not_found' && (
              <p className="text-xs text-amber-200/90">No public Discord application found for this ID — it may be invalid or private.</p>
            )}

            {/* Identity + content */}
            <Field label="Display Name" hint="The card title shown on your profile (defaults to the app identity).">
              <TextInput
                placeholder="10X RPC"
                value={config.name ?? ''}
                onChange={e => patch({ name: e.target.value })}
                aria-label="Application RPC display name"
              />
            </Field>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Type">
                <PillSelect
                  value={config.type ?? 'PLAYING'}
                  onValueChange={v => patch({ type: v })}
                  options={[...TYPE_OPTIONS]}
                />
              </Field>
              <Field label="Session Platform" hint="Meta Quest (VR) is least likely to collide with your other RPC sessions.">
                <div ref={platformRef}>
                  <RpcPlatformSelect
                    value={config.platform ?? 'meta_quest'}
                    onChange={v => patch({ platform: v })}
                    open={platformOpen}
                    onToggle={() => setPlatformOpen(o => !o)}
                    onClose={() => setPlatformOpen(false)}
                  />
                </div>
              </Field>
            </div>

            <Field label="Details" hint="First line under the game title.">
              <TextInput
                placeholder="e.g. Building something great"
                value={config.details ?? ''}
                onChange={e => patch({ details: e.target.value })}
                aria-label="Application RPC details"
              />
            </Field>
            <Field label="State" hint="Second line. Supports placeholders like {time}.">
              <TextInput
                placeholder="e.g. Since {time}"
                value={config.state ?? ''}
                onChange={e => patch({ state: e.target.value })}
                aria-label="Application RPC state"
              />
            </Field>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Large Image" hint="Image URL or asset key.">
                <TextInput
                  placeholder="https://…"
                  value={config.largeImage ?? ''}
                  onChange={e => patch({ largeImage: e.target.value })}
                  aria-label="Application RPC large image"
                />
              </Field>
              <Field label="Large Image Text">
                <TextInput
                  placeholder="Hover text"
                  value={config.largeText ?? ''}
                  onChange={e => patch({ largeText: e.target.value })}
                  aria-label="Application RPC large image text"
                />
              </Field>
              <Field label="Small Image">
                <TextInput
                  placeholder="https://…"
                  value={config.smallImage ?? ''}
                  onChange={e => patch({ smallImage: e.target.value })}
                  aria-label="Application RPC small image"
                />
              </Field>
              <Field label="Small Image Text">
                <TextInput
                  placeholder="Hover text"
                  value={config.smallText ?? ''}
                  onChange={e => patch({ smallText: e.target.value })}
                  aria-label="Application RPC small image text"
                />
              </Field>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Button 1 Label">
                <TextInput
                  placeholder="Play now"
                  value={config.button1Label ?? ''}
                  onChange={e => patch({ button1Label: e.target.value })}
                  aria-label="Application RPC button 1 label"
                />
              </Field>
              <Field label="Button 1 URL">
                <TextInput
                  placeholder="https://…"
                  value={config.button1Url ?? ''}
                  onChange={e => patch({ button1Url: e.target.value })}
                  aria-label="Application RPC button 1 URL"
                />
              </Field>
              <Field label="Button 2 Label">
                <TextInput
                  placeholder="Join server"
                  value={config.button2Label ?? ''}
                  onChange={e => patch({ button2Label: e.target.value })}
                  aria-label="Application RPC button 2 label"
                />
              </Field>
              <Field label="Button 2 URL">
                <TextInput
                  placeholder="https://…"
                  value={config.button2Url ?? ''}
                  onChange={e => patch({ button2Url: e.target.value })}
                  aria-label="Application RPC button 2 URL"
                />
              </Field>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <Field label="Elapsed (min ago)">
                <TextInput
                  inputMode="numeric"
                  placeholder="0"
                  value={String(config.startMinsAgo ?? 0)}
                  onChange={e => patch({ startMinsAgo: Math.max(0, parseInt(e.target.value || '0', 10) || 0) })}
                  aria-label="Application RPC elapsed minutes"
                />
              </Field>
              <Field label="Ends in (min)">
                <TextInput
                  inputMode="numeric"
                  placeholder="none"
                  value={config.endTotalMins != null ? String(config.endTotalMins) : ''}
                  onChange={e => {
                    const v = parseInt(e.target.value || '', 10)
                    patch({ endTotalMins: Number.isFinite(v) && v > 0 ? v : null })
                  }}
                  aria-label="Application RPC ends in minutes"
                />
              </Field>
              <Field label="Party (now / max)">
                <div className="flex gap-2">
                  <TextInput
                    inputMode="numeric"
                    placeholder="1"
                    value={config.partyCurrent != null ? String(config.partyCurrent) : ''}
                    onChange={e => {
                      const v = parseInt(e.target.value || '', 10)
                      patch({ partyCurrent: Number.isFinite(v) && v > 0 ? v : null })
                    }}
                    aria-label="Application RPC party current"
                  />
                  <TextInput
                    inputMode="numeric"
                    placeholder="—"
                    value={config.partyMax != null ? String(config.partyMax) : ''}
                    onChange={e => {
                      const v = parseInt(e.target.value || '', 10)
                      patch({ partyMax: Number.isFinite(v) && v > 0 ? v : null })
                    }}
                    aria-label="Application RPC party max"
                  />
                </div>
              </Field>
            </div>

            <div className="flex items-center gap-3 pt-1">
              <PrimaryButton onClick={handleSave} disabled={saving} data-testid="application-rpc-save">
                {saving ? 'Saving…' : 'Save Application RPC'}
              </PrimaryButton>
              <span className="text-[11px] text-white/35">
                Saving never starts or stops the RPC — use the switch.
              </span>
            </div>
          </div>
        ) : (
          <p className="mt-4 text-sm text-white/50">Could not load the Application RPC configuration — try again.</p>
        )
      )}
    </div>
  )
}
