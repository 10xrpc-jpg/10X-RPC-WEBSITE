// 10X RPC — Per-game config page (#/games/:slug)
'use client'
import { useEffect, useState, useRef } from 'react'
import { toast } from 'sonner'
import { api, type GamePreset, type GameConfig } from '@/lib/api-client'
import { useRouter } from './useRouter'
import { BackButton, PurpleSwitch } from './ui'
import { PLATFORMS, PLATFORM_GROUPS } from '@/lib/constants'
import { Gamepad2, ChevronDown } from 'lucide-react'

export function GameConfigPage({ slug }: { slug: string }) {
  const { navigate } = useRouter()
  const [preset, setPreset] = useState<GamePreset | null>(null)
  const [cfg, setCfg] = useState<GameConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [platformOpen, setPlatformOpen] = useState(false)
  const platformRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node
      if (platformRef.current && !platformRef.current.contains(target)) {
        setPlatformOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    api.gameConfig(slug).then(r => {
      setPreset(r.preset)
      if (r.config) {
        setCfg(r.config)
        setEnabled(r.config.enabled)
      } else {
        setCfg({
          enabled: false,
          platform: r.preset.defaultPlatform,
          state: r.preset.defaultState,
          details: r.preset.defaultDetails,
          largeImage: r.preset.largeImage,
          largeText: r.preset.largeText,
          smallImage: null,
          smallText: null,
          button1Label: null,
          button1Url: null,
          button2Label: null,
          button2Url: null,
          partyCurrent: r.preset.defaultPartyCurrent,
          partyMax: r.preset.defaultPartyMax,
          partyId: null,
          partySecret: null,
          startMinsAgo: 0,
          endTotalMins: r.preset.defaultEndTotalMins,
        })
      }
    }).catch(e => {
      console.error(e)
      navigate({ name: 'games' })
    })
  }, [slug, navigate])

  if (!preset || !cfg) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="inline-block w-8 h-8 rounded-full border-2 border-purple-500/30 border-t-purple-500 animate-spin" />
      </div>
    )
  }

  const set = <K extends keyof GameConfig>(key: K, value: GameConfig[K]) =>
    setCfg(prev => prev ? { ...prev, [key]: value } : prev)

  const handleSave = async () => {
    const errors: string[] = []
    if ((cfg.state || '').length > 128) errors.push('State too long (max 128)')
    if ((cfg.details || '').length > 128) errors.push('Details too long (max 128)')
    if (cfg.button1Label && !cfg.button1Url) errors.push('Button 1 URL required when label is set')
    if (cfg.button2Label && !cfg.button2Url) errors.push('Button 2 URL required when label is set')
    if (cfg.button1Url && !/^https?:\/\//i.test(cfg.button1Url)) errors.push('Button 1 URL must start with http(s)://')
    if (cfg.button2Url && !/^https?:\/\//i.test(cfg.button2Url)) errors.push('Button 2 URL must start with http(s)://')
    if (cfg.partyCurrent > cfg.partyMax) errors.push('Party size cannot exceed party max')
    if (cfg.startMinsAgo < 0) errors.push('Start time cannot be negative')
    if (cfg.endTotalMins != null && cfg.endTotalMins < 1) errors.push('End time must be at least 1 minute')
    if (errors.length > 0) {
      errors.forEach(e => toast.error(e))
      return
    }
    setSaving(true)
    try {
      await api.gameSave(slug, { ...cfg, enabled })
      toast.success(`${preset?.name} config saved`, { duration: 2500 })
      navigate({ name: 'games' })
    } catch (e) {
      console.error(e)
      toast.error('Failed to save config')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen px-4 sm:px-6 py-6 max-w-2xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <BackButton onClick={() => navigate({ name: 'games' })} />
        <div className="flex items-center gap-2.5">
          <Gamepad2 className="w-6 h-6 text-purple-400 stroke-[2.2]" />
          <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight">{preset.name}</h1>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="bg-[#20212a] hover:bg-[#282935] border border-white/10 rounded-xl px-4 py-2 text-xs font-semibold text-white uppercase tracking-wider transition-all active:scale-[0.98] disabled:opacity-50 cursor-pointer"
        >
          {saving ? '...' : 'Save'}
        </button>
      </div>

      {/* Main Glass Card */}
      <div className="relative overflow-hidden bg-gradient-to-b from-[#13111d]/95 via-[#0e0d14]/95 to-[#0a0a0f] border border-white/10 rounded-[28px] p-6 sm:p-7 shadow-2xl backdrop-blur-xl">
        {/* Ambient violet glow at top left */}
        <div className="absolute -top-16 -left-12 w-56 h-56 bg-purple-600/15 rounded-full blur-3xl pointer-events-none" />

        <div className="relative z-10 space-y-4">
          {/* Enable RPC toggle row */}
          <div className="flex items-center justify-between px-1 pb-2 border-b border-white/8">
            <span className="text-sm font-extrabold tracking-widest text-[#a855f7] uppercase">
              ENABLE GAME RPC
            </span>
            <PurpleSwitch checked={enabled} onCheckedChange={setEnabled} />
          </div>

          {/* Device Platform */}
          <FormField label="RPC DEVICE / PLATFORM">
            <div className="relative" ref={platformRef}>
              <button
                type="button"
                onClick={() => setPlatformOpen(v => !v)}
                className="w-full h-12 bg-[#12131a] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-xl px-4 text-sm text-white flex items-center justify-between cursor-pointer transition-colors"
              >
                {(() => {
                  const currentPlatform = PLATFORMS.find(p => p.value === cfg.platform)
                  if (!cfg.platform || cfg.platform === 'desktop' || !currentPlatform) {
                    return <span className="text-white/90 font-medium">None</span>
                  }
                  return (
                    <span className="flex items-center gap-2 text-white/90 font-medium">
                      <span>{currentPlatform.emoji}</span>
                      <span>{currentPlatform.label}</span>
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

          {/* State */}
          <FormField label="STATE">
            <input
              type="text"
              value={cfg.state || ''}
              onChange={e => set('state', e.target.value)}
              placeholder="e.g. In a Match"
              className="w-full h-12 bg-[#12131a] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-xl px-4 text-sm text-white placeholder:text-white/35 outline-none transition-colors"
              maxLength={128}
            />
          </FormField>

          {/* Details */}
          <FormField label="DETAILS">
            <input
              type="text"
              value={cfg.details || ''}
              onChange={e => set('details', e.target.value)}
              placeholder="e.g. Ranked Mode"
              className="w-full h-12 bg-[#12131a] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-xl px-4 text-sm text-white placeholder:text-white/35 outline-none transition-colors"
              maxLength={128}
            />
          </FormField>

          {/* Start Time */}
          <FormField label="START TIME (MINS AGO)">
            <input
              type="number"
              min="0"
              value={cfg.startMinsAgo ?? 0}
              onChange={e => set('startMinsAgo', Number(e.target.value))}
              placeholder="0"
              className="w-full h-12 bg-[#12131a] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-xl px-4 text-sm text-white placeholder:text-white/35 outline-none transition-colors"
            />
          </FormField>

          {/* End Time */}
          <FormField label="END TIME (TOTAL MINS)">
            <input
              type="number"
              min="1"
              value={cfg.endTotalMins ?? ''}
              onChange={e => set('endTotalMins', e.target.value ? Number(e.target.value) : null)}
              placeholder="e.g. 30"
              className="w-full h-12 bg-[#12131a] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-xl px-4 text-sm text-white placeholder:text-white/35 outline-none transition-colors"
            />
          </FormField>

          {/* Party Size */}
          <FormField label="PARTY SIZE">
            <input
              type="number"
              min="0"
              value={cfg.partyCurrent ?? 1}
              onChange={e => set('partyCurrent', Number(e.target.value))}
              placeholder="e.g. 1"
              className="w-full h-12 bg-[#12131a] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-xl px-4 text-sm text-white placeholder:text-white/35 outline-none transition-colors"
            />
          </FormField>

          {/* Party Max */}
          <FormField label="PARTY MAX">
            <input
              type="number"
              min="1"
              value={cfg.partyMax ?? 5}
              onChange={e => set('partyMax', Number(e.target.value))}
              placeholder="e.g. 5"
              className="w-full h-12 bg-[#12131a] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-xl px-4 text-sm text-white placeholder:text-white/35 outline-none transition-colors"
            />
          </FormField>

          {/* Party ID */}
          <FormField label="PARTY ID (OPTIONAL)">
            <input
              type="text"
              value={cfg.partyId || ''}
              onChange={e => set('partyId', e.target.value)}
              placeholder="e.g. random-123"
              className="w-full h-12 bg-[#12131a] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-xl px-4 text-sm text-white placeholder:text-white/35 outline-none transition-colors"
            />
          </FormField>

          {/* Party Secret */}
          <FormField label="PARTY SECRET (JOIN)">
            <input
              type="text"
              value={cfg.partySecret || ''}
              onChange={e => set('partySecret', e.target.value)}
              placeholder="e.g. secret-456"
              className="w-full h-12 bg-[#12131a] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-xl px-4 text-sm text-white placeholder:text-white/35 outline-none transition-colors"
            />
          </FormField>

          {/* Button 1 Label & URL */}
          <FormField label="BUTTON 1 LABEL">
            <input
              type="text"
              value={cfg.button1Label || ''}
              onChange={e => set('button1Label', e.target.value)}
              placeholder="e.g. Join"
              className="w-full h-12 bg-[#12131a] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-xl px-4 text-sm text-white placeholder:text-white/35 outline-none transition-colors"
              maxLength={32}
            />
          </FormField>

          <FormField label="BUTTON 1 URL">
            <input
              type="text"
              value={cfg.button1Url || ''}
              onChange={e => set('button1Url', e.target.value)}
              placeholder="https://..."
              className="w-full h-12 bg-[#12131a] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-xl px-4 text-sm text-white placeholder:text-white/35 outline-none transition-colors"
            />
          </FormField>

          {/* Button 2 Label & URL */}
          <FormField label="BUTTON 2 LABEL">
            <input
              type="text"
              value={cfg.button2Label || ''}
              onChange={e => set('button2Label', e.target.value)}
              placeholder="e.g. Watch"
              className="w-full h-12 bg-[#12131a] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-xl px-4 text-sm text-white placeholder:text-white/35 outline-none transition-colors"
              maxLength={32}
            />
          </FormField>

          <FormField label="BUTTON 2 URL">
            <input
              type="text"
              value={cfg.button2Url || ''}
              onChange={e => set('button2Url', e.target.value)}
              placeholder="https://..."
              className="w-full h-12 bg-[#12131a] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-xl px-4 text-sm text-white placeholder:text-white/35 outline-none transition-colors"
            />
          </FormField>

          {/* Bottom Save Action */}
          <div className="pt-4 border-t border-white/8 flex justify-center">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="bg-[#1e1f26] hover:bg-[#282933] border border-white/10 text-white font-medium text-xs tracking-widest uppercase px-8 py-3 rounded-xl transition-all active:scale-[0.98] disabled:opacity-50 cursor-pointer"
            >
              {saving ? 'SAVING...' : 'SAVE CONFIGURATION'}
            </button>
          </div>
        </div>
      </div>
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
