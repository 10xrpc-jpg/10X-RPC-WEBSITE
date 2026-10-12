// 10X RPC — Global Config page (/config) — timezone, city, temperature unit,
// live clock, weather test, live placeholder preview, copy-to-copy cheat sheet.
'use client'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { api, type PlaceholderEntry } from '@/lib/api-client'
import { useRouter } from './useRouter'
import { Card, SectionTitle, Field, TextInput, PrimaryButton, GhostButton, BackButton, Badge } from './ui'
import { PLACEHOLDER_CHEAT_SHEET } from '@/lib/placeholders'
import { Settings, Eye, Info, MapPin, Clock, Thermometer, Save, LocateFixed, ChevronDown, CloudSun, AlarmClock } from 'lucide-react'

const COMMON_TIMEZONES = [
  'Asia/Calcutta', 'Asia/Kolkata', 'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Singapore',
  'Asia/Dubai', 'Europe/London', 'Europe/Paris', 'Europe/Berlin',
  'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'UTC',
]

const FALLBACK_TIMEZONES = [
  ...COMMON_TIMEZONES,
  'Asia/Seoul', 'Asia/Bangkok', 'Asia/Jakarta', 'Asia/Karachi', 'Asia/Riyadh', 'Asia/Tehran',
  'Australia/Sydney', 'Australia/Melbourne', 'Pacific/Auckland',
  'Europe/Moscow', 'Europe/Istanbul', 'Europe/Madrid', 'Europe/Rome', 'Europe/Amsterdam',
  'America/Toronto', 'America/Mexico_City', 'America/Sao_Paulo', 'America/Bogota', 'America/Argentina/Buenos_Aires',
  'Africa/Cairo', 'Africa/Lagos', 'Africa/Johannesburg', 'Africa/Nairobi',
]

function allTimezones(): string[] {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone')
    if (list && list.length > 0) return list
  } catch {}
  return FALLBACK_TIMEZONES
}

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Calcutta'
  } catch {
    return 'Asia/Calcutta'
  }
}

function tzOffsetLabel(tz: string, now: Date): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(now)
    return parts.find(p => p.type === 'timeZoneName')?.value || ''
  } catch {
    return ''
  }
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

const CHEAT_GROUPS: { title: string; icon: ReactNode; tokens: string[] }[] = [
  { title: 'Time & Date', icon: <Clock className="w-3.5 h-3.5 inline-block align-[-2px] text-white/80" />, tokens: ['{time}', '{time_12h}', '{time_bold}', '{time_emoji}', '{date}', '{date_bold}', '{day}', '{month}', '{year}'] },
  { title: 'Weather & Location', icon: <CloudSun className="w-3.5 h-3.5 inline-block align-[-2px] text-white/80" />, tokens: ['{weather}', '{weather_emoji}', '{temp}', '{temp_c}', '{temp_f}', '{city}'] },
  { title: 'Timers & More', icon: <AlarmClock className="w-3.5 h-3.5 inline-block align-[-2px] text-white/80" />, tokens: ['{uptime}', '{countdown:HH:MM}'] },
]

const EXAMPLES = [
  'Meeting in {countdown:17:30}',
  'Chilling in {city} • {weather}',
  'Code time: {time_bold} • {uptime}',
  "It's {temp} in {city} {weather_emoji}",
]

export function GlobalConfigPage({ initialCity, initialTimezone, initialTempUnit }: { initialCity?: string | null; initialTimezone?: string; initialTempUnit?: string }) {
  const { navigate } = useRouter()
  const [city, setCity] = useState(initialCity || '')
  const [timezone, setTimezone] = useState(initialTimezone || 'Asia/Calcutta')
  const [tempUnit, setTempUnit] = useState<'C' | 'F'>(initialTempUnit === 'F' ? 'F' : 'C')
  const [saving, setSaving] = useState(false)
  const [detecting, setDetecting] = useState(false)

  // Weather test
  const [weather, setWeather] = useState<{ tempC: number; condition: string; emoji: string; city: string } | null>(null)
  const [weatherLoading, setWeatherLoading] = useState(false)
  const [weatherError, setWeatherError] = useState<string | null>(null)

  // Timezone search picker
  const [tzOpen, setTzOpen] = useState(false)
  const [tzQuery, setTzQuery] = useState('')
  const [now, setNow] = useState(() => new Date())
  const tzBoxRef = useRef<HTMLDivElement | null>(null)

  // Live preview
  const [previewText, setPreviewText] = useState("It's {temp} in {city} {weather_emoji} • {time_bold}")
  const [previewOut, setPreviewOut] = useState<string | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)

  const placeholders: PlaceholderEntry[] = PLACEHOLDER_CHEAT_SHEET
  const allTz = useMemo(() => allTimezones(), [])

  const tzFiltered = useMemo(() => {
    const q = tzQuery.trim().toLowerCase()
    const base = q ? allTz.filter(tz => tz.toLowerCase().includes(q)) : allTz
    const preferred = base.filter(tz => COMMON_TIMEZONES.includes(tz) || tz === timezone)
    const rest = base.filter(tz => !preferred.includes(tz))
    return [...preferred, ...rest].slice(0, 60)
  }, [tzQuery, allTz, timezone])

  // Dirty check — preview + save button show unsaved state
  const dirty = city !== (initialCity || '') || timezone !== (initialTimezone || 'Asia/Calcutta') || tempUnit !== (initialTempUnit === 'F' ? 'F' : 'C')

  useEffect(() => {
    if (initialCity !== undefined) setCity(initialCity || '')
    if (initialTimezone && isValidTimezone(initialTimezone)) setTimezone(initialTimezone)
    if (initialTempUnit) setTempUnit(initialTempUnit === 'F' ? 'F' : 'C')
  }, [initialCity, initialTimezone, initialTempUnit])

  // Ticking clock (1s) for the live local-time display
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  // Close the timezone dropdown on outside click
  useEffect(() => {
    if (!tzOpen) return
    const onDoc = (e: MouseEvent) => {
      if (tzBoxRef.current && !tzBoxRef.current.contains(e.target as Node)) setTzOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [tzOpen])

  // Live preview — debounced resolve with the CURRENT (possibly unsaved) values
  useEffect(() => {
    if (!previewText.trim()) { setPreviewOut(null); return }
    setPreviewBusy(true)
    const t = setTimeout(async () => {
      try {
        const r = await api.resolvePlaceholders(previewText, { city: city.trim() || null, timezone, tempUnit })
        setPreviewOut(r.resolved)
      } catch {
        setPreviewOut(null)
      } finally {
        setPreviewBusy(false)
      }
    }, 400)
    return () => clearTimeout(t)
  }, [previewText, city, timezone, tempUnit])

  const handleSave = async () => {
    if (city.length > 100) {
      toast.error('City name too long (max 100 chars)')
      return
    }
    if (!isValidTimezone(timezone)) {
      toast.error('Invalid timezone — pick one from the list')
      return
    }
    setSaving(true)
    try {
      await api.configSave(city.trim() || null, timezone, tempUnit)
      toast.success('Settings saved — placeholders will use these values', { duration: 3000 })
      navigate({ name: 'dashboard' })
    } catch (e) {
      console.error(e)
      toast.error('Failed to save settings')
    } finally {
      setSaving(false)
    }
  }

  const handleAutoDetect = async () => {
    setDetecting(true)
    try {
      const r = await api.configAutoDetect(browserTimezone())
      if (r.globalConfig) {
        setCity(r.globalConfig.city || '')
        setTimezone(r.globalConfig.timezone)
        if (r.globalConfig.tempUnit) setTempUnit(r.globalConfig.tempUnit === 'F' ? 'F' : 'C')
      }
      const how = r.detected ? ` (city: ${r.detected.city}, tz: ${r.detected.timezone})` : ''
      toast.success(`Detected: ${r.globalConfig?.city || '(city unchanged)'} · ${r.globalConfig?.timezone}${how}`, { duration: 4500 })
    } catch (e) {
      console.error(e)
      toast.error('Auto-detect failed — please enter manually')
    } finally {
      setDetecting(false)
    }
  }

  const checkWeather = useCallback(async () => {
    const c = city.trim()
    if (!c) {
      toast.error('Enter a city first')
      return
    }
    setWeatherLoading(true)
    setWeatherError(null)
    setWeather(null)
    try {
      const w = await api.weather(c)
      setWeather(w)
    } catch {
      setWeatherError('City not found — try "Mumbai", "Tokyo", "New York"…')
    } finally {
      setWeatherLoading(false)
    }
  }, [city])

  const copyToken = useCallback(async (token: string) => {
    // Async Clipboard API first; legacy execCommand fallback for restricted
    // contexts (older browsers, permission-denied embedded webviews).
    const legacyCopy = () => {
      try {
        const ta = document.createElement('textarea')
        ta.value = token
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(ta)
        return ok
      } catch {
        return false
      }
    }
    try {
      await navigator.clipboard.writeText(token)
      toast.success(`Copied ${token}`, { duration: 1800 })
    } catch {
      if (legacyCopy()) toast.success(`Copied ${token}`, { duration: 1800 })
      else toast.error('Copy failed — select it manually')
    }
  }, [])

  const localTime = useMemo(() => {
    try {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      }).format(now)
    } catch {
      return '--:--:--'
    }
  }, [now, timezone])

  const localDate = useMemo(() => {
    try {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long',
      }).format(now)
    } catch {
      return ''
    }
  }, [now, timezone])

  return (
    <div className="min-h-screen px-4 sm:px-6 py-6 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <BackButton onClick={() => navigate({ name: 'dashboard' })} />
        <h1 className="text-2xl font-bold text-white">Global Configuration</h1>
        <div className="w-16" />
      </div>

      <p className="text-sm text-white/60 mb-6 text-center">
        Power your RPC with dynamic placeholders — time, weather, location, timers.
        {dirty && <Badge className="ml-2 bg-purple-500/15 text-white border border-purple-500/30">unsaved changes</Badge>}
      </p>

      {/* Live local time */}
      <Card className="mb-6">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <p className="text-[11px] uppercase tracking-wider text-white font-semibold">Live local time</p>
            <p className="text-3xl font-black text-white font-mono mt-1 tabular-nums">{localTime}</p>
            <p className="text-sm text-white/50 mt-0.5">{localDate} · {timezone}{city ? ` · ${city}` : ''}</p>
          </div>
          <Badge className="bg-purple-500/15 text-white border border-purple-500/30">
            <span className="w-2 h-2 rounded-full bg-purple-400 animate-pulse" /> live
          </Badge>
        </div>
      </Card>

      <Card>
        <SectionTitle icon={<Settings className="w-5 h-5 text-white/80" />}>Settings</SectionTitle>

        <div className="space-y-4">
          {/* City + weather test */}
          <Field label={<span className="inline-flex items-center gap-1.5"><MapPin className="w-3.5 h-3.5" />City (For Weather)</span>} hint="Used for {weather}, {temp}, {weather_emoji}, {city} placeholders">
            <div className="flex gap-2">
              <TextInput
                value={city}
                onChange={e => setCity(e.target.value)}
                placeholder="e.g. Mumbai, Tokyo, London"
                className="flex-1"
              />
              <GhostButton onClick={checkWeather} disabled={weatherLoading} className="whitespace-nowrap text-sm">
                {weatherLoading ? 'Checking…' : 'Test weather'}
              </GhostButton>
            </div>
            {weather && (
              <div className="mt-2 glass-card-inner p-3 flex items-center gap-3">
                <span className="text-2xl">{weather.emoji}</span>
                <div>
                  <p className="text-sm font-bold text-white">
                    {tempUnit === 'F' ? `${Math.round(weather.tempC * 9 / 5 + 32)}°F` : `${weather.tempC}°C`} · {weather.condition}
                  </p>
                  <p className="text-xs text-white/50">{weather.city} — {`{temp}`} will render exactly like this</p>
                </div>
              </div>
            )}
            {weatherError && <p className="mt-2 text-xs text-white">{weatherError}</p>}
          </Field>

          {/* Timezone — searchable picker */}
          <Field label={<span className="inline-flex items-center gap-1.5"><Clock className="w-3.5 h-3.5" />Timezone</span>} hint="Used for {time}, {date}, {countdown} placeholders">
            <div className="relative" ref={tzBoxRef}>
              <button
                type="button"
                onClick={() => { setTzOpen(o => !o); setTzQuery('') }}
                className="w-full bg-[#13141a] border border-white/8 text-white rounded-xl px-3 py-2.5 text-left flex items-center justify-between hover:border-white/20 transition-colors"
                aria-haspopup="listbox"
                aria-expanded={tzOpen}
              >
                <span className="truncate">{timezone}</span>
                <span className="text-white/40 text-xs ml-2 inline-flex items-center gap-0.5">{tzOffsetLabel(timezone, now)} <ChevronDown className="w-3 h-3" /></span>
              </button>
              {tzOpen && (
                <div className="absolute z-20 mt-2 w-full bg-[#13141a] border border-white/10 rounded-xl shadow-2xl overflow-hidden" role="listbox">
                  <div className="p-2 border-b border-white/5 flex gap-2">
                    <TextInput
                      autoFocus
                      value={tzQuery}
                      onChange={e => setTzQuery(e.target.value)}
                      placeholder="Search timezones…"
                      className="flex-1"
                    />
                    <GhostButton
                      onClick={() => { setTimezone(browserTimezone()); setTzOpen(false) }}
                      className="text-xs whitespace-nowrap"
                    >
                      Browser
                    </GhostButton>
                  </div>
                  <div className="max-h-72 overflow-y-auto styled-scroll">
                    {tzFiltered.length === 0 && <p className="text-xs text-white/40 p-3">No timezones match “{tzQuery}”</p>}
                    {tzFiltered.map(tz => (
                      <button
                        key={tz}
                        type="button"
                        role="option"
                        aria-selected={tz === timezone}
                        onClick={() => { setTimezone(tz); setTzOpen(false) }}
                        className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between hover:bg-purple-500/10 transition-colors ${tz === timezone ? 'text-white/90' : 'text-white/80'}`}
                      >
                        <span className="truncate">{tz}</span>
                        <span className="text-xs text-white/35 ml-2">{tzOffsetLabel(tz, now)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </Field>

          {/* Temperature unit */}
          <Field label={<span className="inline-flex items-center gap-1.5"><Thermometer className="w-3.5 h-3.5" />Temperature Unit</span>} hint="What {temp} renders — {temp_c} / {temp_f} are always available">
            <div className="inline-flex rounded-xl bg-[#13141a] border border-white/8 p-1" role="radiogroup" aria-label="Temperature unit">
              {(['C', 'F'] as const).map(u => (
                <button
                  key={u}
                  type="button"
                  role="radio"
                  aria-checked={tempUnit === u}
                  onClick={() => setTempUnit(u)}
                  className={`px-5 py-1.5 rounded-lg text-sm font-bold transition-all ${tempUnit === u ? 'purple-gradient text-white shadow' : 'text-white/50 hover:text-white'}`}
                >
                  °{u}
                </button>
              ))}
            </div>
          </Field>

          <div className="flex gap-2 pt-2 flex-wrap">
            <PrimaryButton onClick={handleSave} disabled={saving} className="flex-1 min-w-[160px]">
              {saving ? 'Saving...' : <span className="inline-flex items-center justify-center gap-1.5"><Save className="w-4 h-4" />Save Settings</span>}
            </PrimaryButton>
            <GhostButton onClick={handleAutoDetect} disabled={detecting}>
              {detecting ? 'Detecting...' : <span className="inline-flex items-center gap-1.5"><LocateFixed className="w-4 h-4" />Auto Detect</span>}
            </GhostButton>
          </div>
        </div>
      </Card>

      {/* Live preview */}
      <Card className="mt-6">
        <SectionTitle icon={<Eye className="w-5 h-5 text-white/80" />}>Live Preview</SectionTitle>
        <p className="text-sm text-white/60 mb-3">
          Type anything with placeholders — see exactly what Discord will show, using your current (even unsaved) values.
        </p>
        <TextInput
          value={previewText}
          onChange={e => setPreviewText(e.target.value)}
          placeholder="e.g. Playing in {city} • {temp} • {time}"
        />
        <div className="mt-3 flex flex-wrap gap-2">
          {EXAMPLES.map(ex => (
            <button
              key={ex}
              type="button"
              onClick={() => setPreviewText(ex)}
              className="text-xs px-2.5 py-1 rounded-lg bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 hover:text-white transition-colors font-mono"
            >
              {ex}
            </button>
          ))}
        </div>
        <div className="mt-4 glass-card-inner p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[11px] uppercase tracking-wider text-white font-semibold">Rendered output</p>
            {previewBusy && <span className="text-xs text-white/40">resolving…</span>}
          </div>
          <p className="text-lg text-white font-medium break-words" aria-live="polite">
            {previewOut ?? <span className="text-white/30">Type something above…</span>}
          </p>
        </div>
      </Card>

      {/* Placeholders Cheat Sheet */}
      <Card className="mt-6">
        <SectionTitle icon={<Info className="w-5 h-5 text-white/80" />}>
          <span className="text-white">Placeholder Cheat Sheet</span>
        </SectionTitle>
        <p className="text-sm text-white/60 mb-4">
          Use these in your RPC <strong className="text-white">State</strong> and <strong className="text-white">Details</strong> fields — they auto-update 24/7. Click any token to copy it.
        </p>

        <div className="space-y-5">
          {CHEAT_GROUPS.map(group => {
            const items = placeholders.filter(p => group.tokens.includes(p.token))
            if (items.length === 0) return null
            return (
              <div key={group.title}>
                <p className="text-xs font-bold text-white/70 uppercase tracking-wider mb-2">{group.icon} {group.title}</p>
                <div className="space-y-2">
                  {items.map(p => (
                    <button
                      key={p.token}
                      type="button"
                      onClick={() => copyToken(p.token)}
                      className="w-full flex items-center gap-3 glass-card-inner p-2.5 text-left hover:border-purple-500/40 transition-colors group"
                      title={`Click to copy ${p.token}`}
                    >
                      <code className="px-2.5 py-1 rounded-lg bg-purple-500/20 text-white/90 text-xs font-mono whitespace-nowrap group-hover:bg-purple-500/30 transition-colors">
                        {p.token}
                      </code>
                      <span className="text-xs text-white/70 flex-1">{p.desc}</span>
                      <span className="text-xs text-white/25 group-hover:text-white transition-colors">copy</span>
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
        </div>

        <div className="mt-4 glass-card-inner p-3 border-l-2 border-purple-400">
          <p className="text-xs text-white/90 font-semibold mb-1">Example usage (click to try in preview):</p>
          <div className="space-y-1">
            {EXAMPLES.map(ex => (
              <button
                key={ex}
                type="button"
                onClick={() => { setPreviewText(ex); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
                className="block text-xs text-white/70 font-mono whitespace-pre-wrap leading-relaxed hover:text-white transition-colors text-left"
              >
                {ex}
              </button>
            ))}
          </div>
        </div>
      </Card>
    </div>
  )
}
