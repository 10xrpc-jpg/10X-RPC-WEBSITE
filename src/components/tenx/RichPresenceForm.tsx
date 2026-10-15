// 10X RPC — Rich Presence form
// Multi-RPC: renders ONE RPC slot's configuration. When `slotId` is provided
// the form talks to the per-slot endpoints (/api/rpc/slots/[id]) — each slot
// is saved, toggled and deleted independently; no slot can ever affect another.
'use client'
import { useEffect, useState, useRef } from 'react'
import { toast } from 'sonner'
import { api, type RpcConfig } from '@/lib/api-client'
import { PurpleSwitch } from './ui'
import { ACTIVITY_TYPES } from '@/lib/constants'
import { Gamepad2, ChevronDown, Check, Info, Trash2, ChevronRight, Copy } from 'lucide-react'
import { RpcPlatformSelect } from './RpcPlatformSelect'

const DEFAULT_CONFIG: RpcConfig = {
  name: '10X RPC',
  type: 'PLAYING',
  platform: 'desktop',
  state: '',
  details: '',
  appId: '',
  largeImage: '',
  largeText: '',
  smallImage: '',
  smallText: '',
  button1Label: '',
  button1Url: '',
  button2Label: '',
  button2Url: '',
  partyCurrent: null,
  partyMax: null,
  partyId: '',
  partySecret: '',
  startMinsAgo: 0,
  endTotalMins: null,
  enabled: false,
}

// Discord Application IDs are snowflakes — 15-21 digits (same rule the server enforces).
const APP_ID_RE = /^\d{15,21}$/

// ── "APPLICATION ID (OPTIONAL)" field visibility ──────────────────────
// Task 96 hid this field from the Normal RPC form (UI-only); the user then
// asked to bring it back — it is VISIBLE again. The backend kept FULL support
// the entire time (Task 86 semantics intact):
//   • cfg.appId is saved by /api/rpc/* whenever it holds a value
//     (imports/backups/legacy accounts keep working untouched)
//   • the daemon + presence builder honor a stored custom Application ID
//     (the presence presents under that app — the default remains the 10X
//     RPC application when the field is left empty)
// Flip to false to hide the field again.
const SHOW_APPLICATION_ID_FIELD = true

type AppLookupState =
  | { status: 'idle' }
  | { status: 'invalid' }
  | { status: 'checking' }
  | { status: 'found'; name: string; iconUrl: string | null }
  | { status: 'not_found' }

export function RichPresenceForm({
  initial, onSaved, onToggle, onChange, rpcMode, activeGameName,
  slotId, slotNumber, onDelete, deleting, onDuplicate, duplicating, collapsible, defaultOpen = true,
}: {
  initial: RpcConfig | null | undefined
  onSaved?: () => void
  onToggle?: (v: boolean) => void
  onChange?: (cfg: RpcConfig) => void
  /** Active RPC mode: 'game' while ONLY the Game RPC candidate runs, 'normal' otherwise. */
  rpcMode?: 'normal' | 'game' | null
  /** Name of the currently enabled game (isolated Game RPC), if any. */
  activeGameName?: string | null
  /** Multi-RPC: when set, save/toggle hit the per-slot endpoints. */
  slotId?: string
  /** Multi-RPC: which slot this card is ("RPC 1", "RPC 2", "RPC 3"). */
  slotNumber?: number
  /** Multi-RPC: delete THIS slot only (others are never touched). */
  onDelete?: () => void
  deleting?: boolean
  /** Multi-RPC: duplicate THIS slot's saved fields into the next free slot
   *  (the copy starts disabled). Rendered next to Delete. */
  onDuplicate?: () => void
  duplicating?: boolean
  /** Collapsible card (RPC slots UI); the header always stays visible. */
  collapsible?: boolean
  defaultOpen?: boolean
}) {
  const [cfg, setCfg] = useState<RpcConfig>(initial || DEFAULT_CONFIG)
  const [saving, setSaving] = useState(false)
  const [enabled, setEnabled] = useState(initial?.enabled ?? false)
  const [open, setOpen] = useState(defaultOpen)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const [platformOpen, setPlatformOpen] = useState(false)
  const [typeOpen, setTypeOpen] = useState(false)
  const platformRef = useRef<HTMLDivElement>(null)
  const typeRef = useRef<HTMLDivElement>(null)

  // Application ID live verification — debounced lookup against Discord via
  // /api/games/app-lookup (server-side proxy). Shows the app's official name
  // + icon so the user can confirm the ID before saving.
  const [appLookup, setAppLookup] = useState<AppLookupState>({ status: 'idle' })
  useEffect(() => {
    const raw = (cfg.appId || '').trim()
    if (!raw) {
      setAppLookup({ status: 'idle' })
      return
    }
    if (!APP_ID_RE.test(raw)) {
      setAppLookup({ status: 'invalid' })
      return
    }
    setAppLookup({ status: 'checking' })
    let cancelled = false
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
  }, [cfg.appId])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node
      if (platformRef.current && !platformRef.current.contains(target)) {
        setPlatformOpen(false)
      }
      if (typeRef.current && !typeRef.current.contains(target)) {
        setTypeOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    if (initial) {
      setCfg({
        name: initial.name ?? '10X RPC',
        type: initial.type ?? 'PLAYING',
        platform: initial.platform ?? 'desktop',
        state: initial.state ?? '',
        details: initial.details ?? '',
        appId: initial.appId ?? '',
        largeImage: initial.largeImage ?? '',
        largeText: initial.largeText ?? '',
        smallImage: initial.smallImage ?? '',
        smallText: initial.smallText ?? '',
        button1Label: initial.button1Label ?? '',
        button1Url: initial.button1Url ?? '',
        button2Label: initial.button2Label ?? '',
        button2Url: initial.button2Url ?? '',
        partyCurrent: initial.partyCurrent ?? null,
        partyMax: initial.partyMax ?? null,
        partyId: initial.partyId ?? '',
        partySecret: initial.partySecret ?? '',
        startMinsAgo: initial.startMinsAgo ?? 0,
        endTotalMins: initial.endTotalMins ?? null,
        enabled: initial.enabled ?? false,
      })
      setEnabled(initial.enabled ?? false)
    }
  }, [initial])

  const set = <K extends keyof RpcConfig>(key: K, value: RpcConfig[K]) => {
    setCfg(prev => {
      const next = { ...prev, [key]: value }
      onChange?.(next)
      return next
    })
  }

  const handleSave = async () => {
    const errors: string[] = []
    if ((cfg.name || '').length > 128) errors.push('Name too long (max 128)')
    if ((cfg.state || '').length > 128) errors.push('State too long (max 128)')
    if ((cfg.details || '').length > 128) errors.push('Details too long (max 128)')
    if ((cfg.button1Label || '').length > 32) errors.push('Button 1 label too long (max 32)')
    if ((cfg.button2Label || '').length > 32) errors.push('Button 2 label too long (max 32)')
    if (cfg.button1Url && !/^https?:\/\//i.test(cfg.button1Url)) errors.push('Button 1 URL must start with http:// or https://')
    if (cfg.button2Url && !/^https?:\/\//i.test(cfg.button2Url)) errors.push('Button 2 URL must start with http:// or https://')
    if (cfg.button1Label && !cfg.button1Url) errors.push('Button 1 URL required when label is set')
    if (cfg.button2Label && !cfg.button2Url) errors.push('Button 2 URL required when label is set')
    if (cfg.partyCurrent != null && cfg.partyMax != null && cfg.partyCurrent > cfg.partyMax) {
      errors.push('Party size cannot exceed party max')
    }
    if (cfg.startMinsAgo != null && cfg.startMinsAgo < 0) errors.push('Start time cannot be negative')
    if (cfg.endTotalMins != null && cfg.endTotalMins < 1) errors.push('End time must be at least 1 minute')
    if ((cfg.appId || '').trim() && !APP_ID_RE.test(cfg.appId!.trim())) {
      errors.push('Application ID must be 15-21 digits (numbers only)')
    }
    if (errors.length > 0) {
      errors.forEach(e => toast.error(e))
      return
    }

    setSaving(true)
    try {
      const res = slotId
        ? await api.rpcSlotSave(slotId, { ...cfg, appId: (cfg.appId || '').trim() || undefined, enabled })
        : await api.rpcSave({ ...cfg, appId: (cfg.appId || '').trim() || undefined, enabled })
      if (res.ok) {
        // Server owns the enabled state (config save can never disable the RPC) —
        // surface its authoritative message instead of the local switch value.
        toast.success(res.message || 'Configuration saved', { duration: 2500 })
        onSaved?.()
      } else {
        toast.error('Failed to save configuration')
      }
    } catch (e) {
      console.error(e)
      toast.error('Failed to save Rich Presence')
    } finally {
      setSaving(false)
    }
  }

  const handleToggle = async (v: boolean) => {
    setEnabled(v)
    try {
      const res = slotId
        ? await api.rpcSlotToggle(slotId, v)
        : await api.rpcToggle(v)
      if (res.ok) {
        toast.success(res.message || (v ? 'RPC enabled & live on Discord' : 'RPC stopped & cleared from Discord'), { duration: 2500 })
        onToggle?.(v)
        onSaved?.()
      } else {
        setEnabled(!v)
        toast.error('Failed to toggle RPC')
      }
    } catch (e) {
      console.error(e)
      setEnabled(!v)
      toast.error('Failed to toggle RPC')
    }
  }

  return (
    <div className="space-y-8">
      {/* === RPC SLOT CARD === */}
      <div className="relative overflow-hidden bg-gradient-to-b from-[#13111d]/95 via-[#0e0d14]/95 to-[#0a0a0f] border border-white/10 rounded-[28px] p-6 sm:p-7 shadow-2xl backdrop-blur-xl">
        {/* Ambient violet glow at top */}
        <div className="absolute -top-16 left-1/4 -translate-x-1/2 w-64 h-48 bg-purple-600/15 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -top-16 right-0 w-48 h-48 bg-purple-900/10 rounded-full blur-2xl pointer-events-none" />

        {/* Card header — RPC slot title + live status + (multi-RPC) collapse & delete */}
        <div className="relative z-10 flex items-center gap-2.5 mb-7 pt-1">
          {collapsible ? (
            <button
              type="button"
              onClick={() => setOpen(v => !v)}
              aria-expanded={open}
              aria-label={open ? 'Collapse RPC configuration' : 'Expand RPC configuration'}
              className="flex items-center gap-2.5 flex-1 min-w-0 text-left cursor-pointer group"
            >
              {open
                ? <ChevronDown className="w-5 h-5 shrink-0 text-white/50 group-hover:text-white/80 transition-colors" />
                : <ChevronRight className="w-5 h-5 shrink-0 text-white/50 group-hover:text-white/80 transition-colors" />}
              <Gamepad2 className="w-6 h-6 text-white stroke-[2.2] shrink-0" />
              <h2 className="text-2xl font-bold text-white tracking-tight truncate">
                {slotNumber ? `RPC ${slotNumber}` : 'Rich Presence'}
              </h2>
              <span
                className={`ml-1 inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full border shrink-0 ${
                  enabled
                    ? 'text-purple-200 border-purple-500/40 bg-purple-500/15'
                    : 'text-white/40 border-white/10 bg-white/5'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${enabled ? 'bg-purple-400 animate-pulse' : 'bg-white/30'}`} />
                {enabled ? 'ON' : 'OFF'}
              </span>
            </button>
          ) : (
            <>
              <Gamepad2 className="w-6 h-6 text-white stroke-[2.2] shrink-0" />
              <h2 className="text-2xl font-bold text-white tracking-tight flex-1 min-w-0 truncate">
                {slotNumber ? `RPC ${slotNumber}` : 'Rich Presence'}
              </h2>
            </>
          )}
          {onDelete && (
            <div className="shrink-0 flex items-center gap-1.5">
              {onDuplicate && (
                <button
                  type="button"
                  onClick={onDuplicate}
                  disabled={duplicating || deleting}
                  aria-label={`Duplicate RPC ${slotNumber ?? ''}`}
                  title="Copy this RPC into a new slot (stays disabled)"
                  className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-white/45 hover:text-purple-200 bg-white/5 hover:bg-purple-500/15 border border-white/10 hover:border-purple-500/30 rounded-lg px-2.5 py-1.5 transition-colors disabled:opacity-50"
                >
                  {duplicating
                    ? <span className="inline-block w-3 h-3 border-2 border-white/30 border-t-purple-400 rounded-full animate-spin" aria-hidden />
                    : <Copy className="w-3.5 h-3.5" />}
                  <span className="hidden sm:inline">{duplicating ? 'Copying…' : 'Duplicate'}</span>
                </button>
              )}
              {confirmDelete ? (
                <>
                  <button
                    type="button"
                    onClick={() => { setConfirmDelete(false); onDelete() }}
                    disabled={deleting}
                    className="text-[11px] font-bold uppercase tracking-wide text-white bg-red-600/90 hover:bg-red-600 rounded-lg px-2.5 py-1.5 transition-colors disabled:opacity-50"
                  >
                    {deleting ? 'Deleting…' : 'Confirm'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    disabled={deleting}
                    className="text-[11px] font-semibold uppercase tracking-wide text-white/60 hover:text-white bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5 transition-colors disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  disabled={deleting}
                  aria-label={`Delete RPC ${slotNumber ?? ''}`}
                  title="Delete this RPC"
                  className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-white/45 hover:text-red-300 bg-white/5 hover:bg-red-500/15 border border-white/10 hover:border-red-500/30 rounded-lg px-2.5 py-1.5 transition-colors disabled:opacity-50"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Delete RPC</span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* Multi-RPC notice: the isolated Game RPC runs ALONGSIDE the slots —
            neither mode ever overwrites the other's saved configuration. */}
        {rpcMode === 'game' && (
          <div className="relative z-10 mb-5 flex items-start gap-2.5 text-xs text-white/80 bg-purple-500/10 border border-purple-500/25 rounded-xl px-3.5 py-2.5">
            <Gamepad2 className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
            <span>
              <strong>Game RPC is currently active{activeGameName ? ` — ${activeGameName}` : ''}.</strong>{' '}
              It runs alongside your RPCs — enabling RPC below adds this slot back without touching the game.
            </span>
          </div>
        )}

        {/* Form Fields */}
        <div className={`relative z-10 space-y-4 ${collapsible && !open ? 'hidden' : ''}`}>
          {/* 1. ACTIVITY TYPE */}
          <FormField label="ACTIVITY TYPE">
            <div className="relative" ref={typeRef}>
              <button
                type="button"
                onClick={() => { setTypeOpen(v => !v); setPlatformOpen(false) }}
                className="w-full h-12 bg-[#12131a] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-xl px-4 text-sm text-white flex items-center justify-between cursor-pointer uppercase font-medium transition-colors"
              >
                <span>{cfg.type || 'PLAYING'}</span>
                <ChevronDown className={`w-4 h-4 text-white/50 transition-transform ${typeOpen ? 'rotate-180' : ''}`} />
              </button>

              {typeOpen && (
                <div className="absolute left-0 top-full mt-2 w-full bg-[#161720]/98 backdrop-blur-xl border border-white/10 rounded-2xl p-1.5 shadow-2xl z-50 space-y-1">
                  {ACTIVITY_TYPES.map(t => {
                    const isSelected = (cfg.type || 'PLAYING') === t.label
                    return (
                      <button
                        key={t.label}
                        type="button"
                        onClick={() => { set('type', t.label); setTypeOpen(false) }}
                        className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-xs font-medium uppercase transition-colors text-left ${
                          isSelected
                            ? 'bg-[#6b21a8] text-white font-semibold'
                            : 'text-white/80 hover:text-white hover:bg-white/5'
                        }`}
                      >
                        <span>{t.label}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </FormField>

          {/* 2. RPC DEVICE / PLATFORM */}
          <FormField label="RPC DEVICE / PLATFORM">
            <div ref={platformRef}>
              <RpcPlatformSelect
                value={cfg.platform || 'desktop'}
                onChange={v => set('platform', v)}
                open={platformOpen}
                onToggle={() => { setPlatformOpen(v => !v); setTypeOpen(false) }}
                onClose={() => setPlatformOpen(false)}
              />
            </div>
          </FormField>

          {/* 3. NAME */}
          <FormField label="NAME">
            <input
              type="text"
              value={cfg.name || ''}
              onChange={e => set('name', e.target.value)}
              placeholder="e.g. Visual Studio Code"
              className="w-full h-12 bg-[#12131a] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-xl px-4 text-sm text-white placeholder:text-white/35 outline-none transition-colors"
              maxLength={128}
            />
          </FormField>

          {/* 4. STATE */}
          <FormField label="STATE">
            <input
              type="text"
              value={cfg.state || ''}
              onChange={e => set('state', e.target.value)}
              placeholder="e.g. Editing page.tsx"
              className="w-full h-12 bg-[#12131a] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-xl px-4 text-sm text-white placeholder:text-white/35 outline-none transition-colors"
              maxLength={128}
            />
          </FormField>

          {/* 5. DETAILS */}
          <FormField label="DETAILS">
            <input
              type="text"
              value={cfg.details || ''}
              onChange={e => set('details', e.target.value)}
              placeholder="e.g. Workspace: Project"
              className="w-full h-12 bg-[#12131a] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-xl px-4 text-sm text-white placeholder:text-white/35 outline-none transition-colors"
              maxLength={128}
            />
          </FormField>

          {/* 6. APPLICATION ID (OPTIONAL) — visible again (hidden in Task 96,
              restored at the user's request; see SHOW_APPLICATION_ID_FIELD
              above). The backend always kept saving/honoring cfg.appId. */}
          {SHOW_APPLICATION_ID_FIELD && (
          <FormField label="APPLICATION ID (OPTIONAL)">
            <input
              type="text"
              value={cfg.appId || ''}
              onChange={e => set('appId', e.target.value.replace(/[^\d]/g, '').slice(0, 21))}
              placeholder="Your Discord Application ID — e.g. 1402418491272986635"
              inputMode="numeric"
              autoComplete="off"
              className={`w-full h-12 bg-[#12131a] border rounded-xl px-4 text-sm text-white placeholder:text-white/35 outline-none transition-colors ${
                appLookup.status === 'invalid'
                  ? 'border-purple-500/60 focus:border-purple-400/70'
                  : appLookup.status === 'found'
                    ? 'border-purple-400/60 focus:border-purple-300/70'
                    : appLookup.status === 'not_found'
                      ? 'border-purple-500/60 focus:border-purple-400/70'
                      : 'border-white/10 hover:border-white/20 focus:border-purple-500/50'
              }`}
            />

            {/* Live verification chip (debounced Discord lookup) */}
            {appLookup.status === 'checking' && (
              <p className="flex items-center gap-2 text-[11px] text-white/50 px-1" role="status" aria-live="polite">
                <span className="inline-block w-3 h-3 border-2 border-white/30 border-t-purple-400 rounded-full animate-spin" aria-hidden />
                Verifying application…
              </p>
            )}
            {appLookup.status === 'invalid' && (
              <p className="text-[11px] text-white/80 px-1" role="status" aria-live="polite">
                Application IDs are 15-21 digits (numbers only). You can find yours in the Discord Developer Portal → your app → General Information → Application ID → Copy.
              </p>
            )}
            {appLookup.status === 'found' && (
              <div className="flex items-center gap-2.5 bg-purple-500/10 border border-purple-500/30 rounded-xl px-3 py-2" role="status" aria-live="polite">
                {appLookup.iconUrl ? (
                  <img src={appLookup.iconUrl} alt={`${appLookup.name} icon`} className="w-6 h-6 rounded-md object-cover flex-shrink-0" />
                ) : (
                  <span className="w-6 h-6 rounded-md bg-purple-600/30 flex items-center justify-center text-[10px] font-bold text-white/90 flex-shrink-0" aria-hidden>
                    {(appLookup.name || '?').slice(0, 1).toUpperCase()}
                  </span>
                )}
                <span className="text-xs text-white/90">
                  <Check className="w-3.5 h-3.5 inline-block align-[-3px] mr-0.5" /><strong className="font-semibold">{appLookup.name}</strong> — this presence will run as that application
                </span>
              </div>
            )}
            {appLookup.status === 'not_found' && (
              <p className="text-[11px] text-white/80 px-1" role="status" aria-live="polite">
                Application not found — double-check the ID in the Discord Developer Portal.
              </p>
            )}
            {appLookup.status === 'idle' && (
              <p className="text-[11px] text-white/40 px-1">
                Paste a Discord Application ID and your Rich Presence is presented as{' '}
                <strong className="text-white/60">that application</strong> (your own app identity, with a live verification check above).{' '}
                Leave empty to use the 10X identity. Find your ID at{' '}
                <a
                  href="https://discord.com/developers/applications"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-white/90 hover:text-white underline underline-offset-2"
                >
                  discord.com/developers/applications
                </a>{' '}
                → your app → General Information → Application ID.
              </p>
            )}
          </FormField>
          )}

          {/* 7. LARGE IMAGE (URL OR ID) */}
          <FormField label="LARGE IMAGE (URL OR ID)">
            <input
              type="text"
              value={cfg.largeImage || ''}
              onChange={e => set('largeImage', e.target.value)}
              placeholder="https://... or ID"
              className="w-full h-12 bg-[#12131a] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-xl px-4 text-sm text-white placeholder:text-white/35 outline-none transition-colors"
            />
          </FormField>

          {/* 7. LARGE IMAGE TEXT */}
          <FormField label="LARGE IMAGE TEXT">
            <input
              type="text"
              value={cfg.largeText || ''}
              onChange={e => set('largeText', e.target.value)}
              placeholder="Hover text"
              className="w-full h-12 bg-[#12131a] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-xl px-4 text-sm text-white placeholder:text-white/35 outline-none transition-colors"
              maxLength={128}
            />
          </FormField>

          {/* 8. SMALL IMAGE (URL OR ID) */}
          <FormField label="SMALL IMAGE (URL OR ID)">
            <input
              type="text"
              value={cfg.smallImage || ''}
              onChange={e => set('smallImage', e.target.value)}
              placeholder="https://... or ID"
              className="w-full h-12 bg-[#12131a] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-xl px-4 text-sm text-white placeholder:text-white/35 outline-none transition-colors"
            />
          </FormField>

          {/* 9. SMALL IMAGE TEXT */}
          <FormField label="SMALL IMAGE TEXT">
            <input
              type="text"
              value={cfg.smallText || ''}
              onChange={e => set('smallText', e.target.value)}
              placeholder="Hover text"
              className="w-full h-12 bg-[#12131a] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-xl px-4 text-sm text-white placeholder:text-white/35 outline-none transition-colors"
              maxLength={128}
            />
          </FormField>

          {/* 10. BUTTON 1 LABEL */}
          <FormField label="BUTTON 1 LABEL">
            <input
              type="text"
              value={cfg.button1Label || ''}
              onChange={e => set('button1Label', e.target.value)}
              placeholder="e.g. View Repo"
              className="w-full h-12 bg-[#12131a] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-xl px-4 text-sm text-white placeholder:text-white/35 outline-none transition-colors"
              maxLength={32}
            />
          </FormField>

          {/* 11. BUTTON 1 URL */}
          <FormField label="BUTTON 1 URL">
            <input
              type="text"
              value={cfg.button1Url || ''}
              onChange={e => set('button1Url', e.target.value)}
              placeholder="https://github.com/..."
              className="w-full h-12 bg-[#12131a] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-xl px-4 text-sm text-white placeholder:text-white/35 outline-none transition-colors"
            />
          </FormField>

          {/* 12. BUTTON 2 LABEL */}
          <FormField label="BUTTON 2 LABEL">
            <input
              type="text"
              value={cfg.button2Label || ''}
              onChange={e => set('button2Label', e.target.value)}
              placeholder="e.g. Join Server"
              className="w-full h-12 bg-[#12131a] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-xl px-4 text-sm text-white placeholder:text-white/35 outline-none transition-colors"
              maxLength={32}
            />
          </FormField>

          {/* 13. BUTTON 2 URL */}
          <FormField label="BUTTON 2 URL">
            <input
              type="text"
              value={cfg.button2Url || ''}
              onChange={e => set('button2Url', e.target.value)}
              placeholder="https://discord.gg/..."
              className="w-full h-12 bg-[#12131a] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-xl px-4 text-sm text-white placeholder:text-white/35 outline-none transition-colors"
            />
          </FormField>

          {/* Button visibility note */}
          <div className="col-span-full -mt-1 mb-1 flex items-center gap-2 text-xs text-white/50 bg-purple-500/10 border border-purple-500/20 rounded-xl px-3.5 py-2.5">
            <Info className="w-4 h-4 shrink-0" />
            <span><strong>Discord Button Visibility:</strong> Buttons are displayed on your profile when <em>other users/friends</em> view your profile. Discord client intentionally hides buttons when you view your own profile.</span>
          </div>

          {/* 14. PARTY SIZE */}
          <FormField label="PARTY SIZE">
            <input
              type="number"
              min="0"
              value={cfg.partyCurrent ?? ''}
              onChange={e => set('partyCurrent', e.target.value ? Number(e.target.value) : null)}
              placeholder="e.g. 1"
              className="w-full h-12 bg-[#12131a] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-xl px-4 text-sm text-white placeholder:text-white/35 outline-none transition-colors"
            />
          </FormField>

          {/* 15. PARTY MAX */}
          <FormField label="PARTY MAX">
            <input
              type="number"
              min="1"
              value={cfg.partyMax ?? ''}
              onChange={e => set('partyMax', e.target.value ? Number(e.target.value) : null)}
              placeholder="e.g. 8"
              className="w-full h-12 bg-[#12131a] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-xl px-4 text-sm text-white placeholder:text-white/35 outline-none transition-colors"
            />
          </FormField>

          {/* 16. PARTY ID (OPTIONAL) */}
          <FormField label="PARTY ID (OPTIONAL)">
            <input
              type="text"
              value={cfg.partyId || ''}
              onChange={e => set('partyId', e.target.value)}
              placeholder="e.g. random-123"
              className="w-full h-12 bg-[#12131a] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-xl px-4 text-sm text-white placeholder:text-white/35 outline-none transition-colors"
            />
          </FormField>

          {/* 17. PARTY SECRET (JOIN) */}
          <FormField label="PARTY SECRET (JOIN)">
            <input
              type="text"
              value={cfg.partySecret || ''}
              onChange={e => set('partySecret', e.target.value)}
              placeholder="e.g. secret-456"
              className="w-full h-12 bg-[#12131a] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-xl px-4 text-sm text-white placeholder:text-white/35 outline-none transition-colors"
            />
          </FormField>

          {/* 18. START TIME (MINS AGO) */}
          <FormField label="START TIME (MINS AGO)">
            <input
              type="number"
              min="0"
              value={cfg.startMinsAgo ?? ''}
              onChange={e => set('startMinsAgo', e.target.value ? Number(e.target.value) : 0)}
              placeholder="1"
              className="w-full h-12 bg-[#12131a] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-xl px-4 text-sm text-white placeholder:text-white/35 outline-none transition-colors"
            />
          </FormField>

          {/* 19. END TIME (TOTAL MINS FROM START) */}
          <FormField label="END TIME (TOTAL MINS FROM START)">
            <input
              type="number"
              min="1"
              value={cfg.endTotalMins ?? ''}
              onChange={e => set('endTotalMins', e.target.value ? Number(e.target.value) : null)}
              placeholder="e.g. 34"
              className="w-full h-12 bg-[#12131a] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-xl px-4 text-sm text-white placeholder:text-white/35 outline-none transition-colors"
            />
          </FormField>

          {/* Divider line before ENABLE RPC */}
          <div className="border-t border-white/10 pt-6 mt-6">
            {/* ENABLE RPC Toggle Row — THIS slot's own independent status */}
            <div className="flex items-center justify-between px-1 mb-5">
              <span className="text-sm sm:text-base font-extrabold tracking-widest text-purple-400 uppercase">
                ENABLE RPC{slotNumber ? ` ${slotNumber}` : ''}
              </span>
              <PurpleSwitch checked={enabled} onCheckedChange={handleToggle} />
            </div>

            {/* Centered UPDATE Button */}
            <div className="flex justify-center">
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="purple-gradient shadow-lg shadow-purple-900/30 hover:opacity-90 text-white font-medium text-xs tracking-widest uppercase px-8 py-3 rounded-xl transition-all active:scale-[0.98] disabled:opacity-50"
              >
                {saving ? 'SAVING...' : 'UPDATE'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-bold tracking-wider text-purple-400 uppercase block">
        {label}
      </label>
      {children}
    </div>
  )
}
