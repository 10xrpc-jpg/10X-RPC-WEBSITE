// 10X RPC — Rich Presence form (matches Roxy reference exactly)
'use client'
import { useEffect, useState, useRef } from 'react'
import { toast } from 'sonner'
import { api, type RpcConfig } from '@/lib/api-client'
import { PurpleSwitch } from './ui'
import { ACTIVITY_TYPES, PLATFORMS, PLATFORM_GROUPS } from '@/lib/constants'
import { Gamepad2, ChevronDown, ChevronsDown } from 'lucide-react'

const DEFAULT_CONFIG: RpcConfig = {
  name: '10X RPC',
  type: 'PLAYING',
  platform: 'desktop',
  state: '',
  details: '',
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

export function RichPresenceForm({
  initial, onSaved, onToggle, onGameRpcClick, onChange,
}: {
  initial: RpcConfig | null | undefined
  onSaved?: () => void
  onToggle?: (v: boolean) => void
  onGameRpcClick?: () => void
  onChange?: (cfg: RpcConfig) => void
}) {
  const [cfg, setCfg] = useState<RpcConfig>(initial || DEFAULT_CONFIG)
  const [saving, setSaving] = useState(false)
  const [enabled, setEnabled] = useState(initial?.enabled ?? false)

  const [platformOpen, setPlatformOpen] = useState(false)
  const [typeOpen, setTypeOpen] = useState(false)
  const platformRef = useRef<HTMLDivElement>(null)
  const typeRef = useRef<HTMLDivElement>(null)

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
    if (errors.length > 0) {
      errors.forEach(e => toast.error(e))
      return
    }

    setSaving(true)
    try {
      const res = await api.rpcSave({ ...cfg, enabled })
      if (res.ok) {
        toast.success(enabled ? 'Rich Presence updated & live on Discord' : 'Configuration saved (RPC is OFF)', { duration: 2500 })
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
      const res = await api.rpcToggle(v)
      if (res.ok) {
        toast.success(v ? 'RPC enabled & live on Discord' : 'RPC stopped & cleared from Discord', { duration: 2500 })
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
      {/* === RICH PRESENCE CARD (Matches roxydev.xyz reference) === */}
      <div className="relative overflow-hidden bg-gradient-to-b from-[#13111d]/95 via-[#0e0d14]/95 to-[#0a0a0f] border border-white/10 rounded-[28px] p-6 sm:p-7 shadow-2xl backdrop-blur-xl">
        {/* Ambient violet glow at top */}
        <div className="absolute -top-16 left-1/4 -translate-x-1/2 w-64 h-48 bg-purple-600/15 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -top-16 right-0 w-48 h-48 bg-purple-900/10 rounded-full blur-2xl pointer-events-none" />

        {/* Centered Card Title: 🎮 Rich Presence */}
        <div className="relative z-10 flex items-center justify-center gap-2.5 mb-7 pt-1">
          <Gamepad2 className="w-6 h-6 text-purple-400 stroke-[2.2]" />
          <h2 className="text-2xl font-bold text-white tracking-tight">Rich Presence</h2>
        </div>

        {/* Form Fields */}
        <div className="relative z-10 space-y-4">
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
            <div className="relative" ref={platformRef}>
              <button
                type="button"
                onClick={() => { setPlatformOpen(v => !v); setTypeOpen(false) }}
                className="w-full h-12 bg-[#12131a] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-xl px-4 text-sm text-white flex items-center justify-between cursor-pointer transition-colors"
              >
                {(() => {
                  const currentPlatform = PLATFORMS.find(p => p.value === cfg.platform)
                  if (!cfg.platform || cfg.platform === 'desktop') {
                    return <span className="text-white/90 font-medium">None</span>
                  }
                  return (
                    <span className="flex items-center gap-2 text-white/90 font-medium">
                      <span>{currentPlatform?.emoji || '🖥️'}</span>
                      <span>{currentPlatform?.label || cfg.platform}</span>
                    </span>
                  )
                })()}
                <ChevronDown className={`w-4 h-4 text-white/50 transition-transform ${platformOpen ? 'rotate-180' : ''}`} />
              </button>

              {platformOpen && (
                <div className="absolute left-0 top-full mt-2 w-full max-h-80 overflow-y-auto bg-[#161720]/98 backdrop-blur-xl border border-white/10 rounded-2xl p-2 shadow-2xl z-50 space-y-2">
                  {/* None option */}
                  <button
                    type="button"
                    onClick={() => { set('platform', 'desktop'); setPlatformOpen(false) }}
                    className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs transition-colors text-left ${
                      (!cfg.platform || cfg.platform === 'desktop')
                        ? 'bg-[#6b21a8] text-white font-medium'
                        : 'text-white/80 hover:text-white hover:bg-white/5'
                    }`}
                  >
                    <span>None</span>
                  </button>

                  {/* Grouped Platform Categories */}
                  {PLATFORM_GROUPS.map(group => (
                    <div key={group} className="mb-1.5">
                      <p className="text-[10px] uppercase tracking-wider text-white/40 px-2 py-1 font-semibold">{group}</p>
                      <div className="space-y-0.5">
                        {PLATFORMS.filter(p => p.group === group).map(p => {
                          const isSelected = cfg.platform === p.value
                          return (
                            <button
                              key={p.value}
                              type="button"
                              onClick={() => { set('platform', p.value); setPlatformOpen(false) }}
                              className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs transition-colors text-left ${
                                isSelected
                                  ? 'bg-[#6b21a8] text-white font-medium shadow-sm'
                                  : 'text-white/80 hover:text-white hover:bg-white/5'
                              }`}
                            >
                              <span>{p.emoji}</span>
                              <span>{p.label}</span>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
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

          {/* 6. LARGE IMAGE (URL OR ID) */}
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
            <span>ℹ️</span>
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
            {/* ENABLE RPC Toggle Row */}
            <div className="flex items-center justify-between px-1 mb-5">
              <span className="text-sm sm:text-base font-extrabold tracking-widest text-[#a855f7] uppercase">
                ENABLE RPC
              </span>
              <PurpleSwitch checked={enabled} onCheckedChange={handleToggle} />
            </div>

            {/* Centered UPDATE Button */}
            <div className="flex justify-center">
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="bg-[#1e1f26] hover:bg-[#282933] border border-white/10 text-white font-medium text-xs tracking-widest uppercase px-8 py-3 rounded-xl transition-all active:scale-[0.98] disabled:opacity-50"
              >
                {saving ? 'SAVING...' : 'UPDATE'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* === "want something cool ?" & TRY GAME RPC NOW (Matches Screenshot 2) === */}
      {onGameRpcClick && (
        <div className="text-center pt-2 pb-6 space-y-4">
          <div className="space-y-1 font-['Comic_Sans_MS',_'Chalkboard_SE',_'Comic_Neue',_cursive,_sans-serif]">
            <p className="text-3xl sm:text-4xl text-white font-normal tracking-wide">
              want something cool
            </p>
            <p className="text-3xl sm:text-4xl text-white font-normal">
              ?
            </p>
          </div>

          <div className="flex justify-center py-1">
            <ChevronsDown className="w-8 h-8 text-purple-400 stroke-[2.5] animate-bounce" />
          </div>

          {/* Giant Game RPC Button */}
          <button
            type="button"
            onClick={onGameRpcClick}
            className="w-full py-7 px-4 rounded-[28px] bg-gradient-to-r from-[#221b36] via-[#352554] to-[#221b36] border border-purple-500/35 hover:border-purple-400/60 shadow-2xl shadow-purple-950/50 text-center transition-all cursor-pointer group active:scale-[0.99]"
          >
            <div className="text-2xl sm:text-3xl font-black tracking-wider text-purple-200 group-hover:text-white transition-colors">
              TRY GAME RPC
            </div>
            <div className="text-2xl sm:text-3xl font-black tracking-wider text-purple-200 group-hover:text-white transition-colors mt-0.5">
              NOW
            </div>
          </button>
        </div>
      )}
    </div>
  )
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-bold tracking-wider text-[#a855f7] uppercase block">
        {label}
      </label>
      {children}
    </div>
  )
}
