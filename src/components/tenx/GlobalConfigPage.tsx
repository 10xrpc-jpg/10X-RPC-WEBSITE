// 10X RPC — Global Config page (#/config)
'use client'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api, type PlaceholderEntry } from '@/lib/api-client'
import { useRouter } from './useRouter'
import { Card, SectionTitle, Field, TextInput, PrimaryButton, GhostButton, BackButton } from './ui'
import { PLACEHOLDER_CHEAT_SHEET } from '@/lib/placeholders'

const COMMON_TIMEZONES = [
  'Asia/Calcutta', 'Asia/Kolkata', 'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Singapore',
  'Asia/Dubai', 'Europe/London', 'Europe/Paris', 'Europe/Berlin',
  'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'UTC',
]

export function GlobalConfigPage({ initialCity, initialTimezone }: { initialCity?: string | null; initialTimezone?: string }) {
  const { navigate } = useRouter()
  const [city, setCity] = useState(initialCity || '')
  const [timezone, setTimezone] = useState(initialTimezone || 'Asia/Calcutta')
  const [saving, setSaving] = useState(false)
  const [detecting, setDetecting] = useState(false)
  const [placeholders] = useState<PlaceholderEntry[]>(PLACEHOLDER_CHEAT_SHEET)

  useEffect(() => {
    if (initialCity !== undefined) setCity(initialCity || '')
    if (initialTimezone) setTimezone(initialTimezone)
  }, [initialCity, initialTimezone])

  const handleSave = async () => {
    // Validation
    if (city.length > 100) {
      toast.error('City name too long (max 100 chars)')
      return
    }
    setSaving(true)
    try {
      await api.configSave(city.trim() || null, timezone)
      toast.success('Settings saved', { duration: 2500 })
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
      await api.configAutoDetect()
      const me = await api.me()
      if (me.globalConfig) {
        setCity(me.globalConfig.city || '')
        setTimezone(me.globalConfig.timezone)
        toast.success(`Detected: ${me.globalConfig.city || '(unknown city)'}, ${me.globalConfig.timezone}`, { duration: 3500 })
      } else {
        toast.success('Auto-detect complete', { duration: 2000 })
      }
    } catch (e) {
      console.error(e)
      toast.error('Auto-detect failed — please enter manually')
    } finally {
      setDetecting(false)
    }
  }

  return (
    <div className="min-h-screen px-4 sm:px-6 py-6 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <BackButton onClick={() => navigate({ name: 'dashboard' })} />
        <h1 className="text-2xl font-bold text-white">Global Configuration</h1>
        <div className="w-16" />
      </div>

      <p className="text-sm text-white/60 mb-6 text-center">
        Configure your timezone and location for dynamic RPC placeholders.
      </p>

      <Card>
        <SectionTitle icon={<span className="text-xl">⚙️</span>}>Settings</SectionTitle>

        <div className="space-y-4">
          <Field label="📍 City (For Weather)" hint="Used for {weather}, {temp}, {weather_emoji}, {city} placeholders">
            <TextInput
              value={city}
              onChange={e => setCity(e.target.value)}
              placeholder="e.g. Mumbai, Tokyo, London"
            />
          </Field>

          <Field label="🕐 Timezone" hint="Used for {time}, {date}, {countdown} placeholders">
            <select
              value={timezone}
              onChange={e => setTimezone(e.target.value)}
              className="w-full bg-[#13141a] border border-white/8 text-white rounded-xl px-3 py-2.5 outline-none focus:ring-2 focus:ring-purple-500/40"
            >
              {COMMON_TIMEZONES.map(tz => (
                <option key={tz} value={tz} className="bg-[#13141a]">{tz}</option>
              ))}
              {!COMMON_TIMEZONES.includes(timezone) && (
                <option value={timezone} className="bg-[#13141a]">{timezone}</option>
              )}
            </select>
          </Field>

          <div className="flex gap-2 pt-2">
            <PrimaryButton onClick={handleSave} disabled={saving} className="flex-1">
              {saving ? 'Saving...' : '💾 Save Settings'}
            </PrimaryButton>
            <GhostButton onClick={handleAutoDetect} disabled={detecting}>
              {detecting ? 'Detecting...' : 'Auto Detect'}
            </GhostButton>
          </div>
        </div>
      </Card>

      {/* Placeholders Cheat Sheet */}
      <Card className="mt-6">
        <SectionTitle icon={<span className="text-xl">ℹ️</span>}>
          <span className="text-purple-400">Dynamic Placeholders Cheat Sheet</span>
        </SectionTitle>
        <p className="text-sm text-white/60 mb-4">
          You can use these placeholders in your RPC <strong className="text-white">State</strong> and <strong className="text-white">Details</strong> fields. They will auto-update!
        </p>

        <div className="space-y-2">
          {placeholders.map(p => (
            <div
              key={p.token}
              className="flex items-center gap-3 glass-card-inner p-2.5"
            >
              <code className="px-2.5 py-1 rounded-lg bg-purple-500/20 text-purple-300 text-xs font-mono whitespace-nowrap">
                {p.token}
              </code>
              <span className="text-xs text-white/70">{p.desc}</span>
            </div>
          ))}
        </div>

        <div className="mt-4 glass-card-inner p-3 border-l-2 border-orange-400">
          <p className="text-xs text-orange-300 font-semibold mb-1">Example usage:</p>
          <pre className="text-xs text-white/70 font-mono whitespace-pre-wrap leading-relaxed">
{`"Meeting in {countdown:17:30}"
"Chilling in {city} • {weather}"
"Code time: {time_bold} • {uptime}"
"It's {temp} in {city} {weather_emoji}"`}
          </pre>
        </div>
      </Card>
    </div>
  )
}
