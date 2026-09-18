// 10X RPC — Smart Sleep Timer card (matches Roxy reference exactly)
'use client'
import { useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api-client'
import { Clock } from 'lucide-react'

export function SmartSleepTimerCard({ currentEndsAt, onSaved }: { currentEndsAt?: string | null; onSaved?: () => void }) {
  const [hours, setHours] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSave = async () => {
    setError(null)
    const h = Number(hours)
    if (!hours || !Number.isFinite(h)) {
      setError('Enter a valid number')
      return
    }
    if (h <= 0) {
      setError('Hours must be greater than 0')
      return
    }
    if (h > 24 * 7) {
      setError('Maximum is 168 hours (1 week)')
      return
    }
    setSaving(true)
    try {
      await api.sleepTimer(h)
      toast.success(`Sleep timer set for ${h} hour${h === 1 ? '' : 's'}`, { duration: 2500 })
      setHours('')
      onSaved?.()
    } catch (e) {
      console.error(e)
      toast.error('Failed to set sleep timer')
    } finally {
      setSaving(false)
    }
  }

  const handleCancel = async () => {
    setSaving(true)
    try {
      await api.sleepTimer(null)
      toast.success('Sleep timer cancelled', { duration: 2000 })
      onSaved?.()
    } catch (e) {
      console.error(e)
      toast.error('Failed to cancel timer')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="relative overflow-hidden bg-gradient-to-b from-[#13111d]/95 via-[#0e0d14]/95 to-[#0a0a0f] border border-white/10 rounded-[28px] p-6 sm:p-7 shadow-2xl backdrop-blur-xl">
      {/* Ambient violet glow at top left */}
      <div className="absolute -top-16 -left-12 w-56 h-56 bg-purple-600/15 rounded-full blur-3xl pointer-events-none" />

      <div className="relative z-10">
        {/* Title: 🕒 Smart Sleep Timer (centered) */}
        <div className="flex items-center justify-center gap-2.5 mb-2.5">
          <Clock className="w-6 h-6 text-purple-400 stroke-[2.2]" />
          <h2 className="text-2xl font-bold text-white tracking-tight">Smart Sleep Timer</h2>
        </div>

        {/* Subtitle */}
        <p className="text-sm text-white/60 text-center max-w-sm mx-auto leading-relaxed mb-6">
          Automatically turn off your Roxy connection after a set amount of time.
        </p>

        {/* Input Row: [ ex. 1.5 or 3 ] Hours [ SAVE ] */}
        <div className="flex items-center justify-center gap-3">
          <input
            type="number"
            step="0.5"
            min="0.5"
            max="168"
            placeholder="ex. 1.5 or 3"
            value={hours}
            onChange={e => {
              setHours(e.target.value)
              setError(null)
            }}
            className="w-36 h-11 bg-transparent border border-purple-500/40 hover:border-purple-400/60 focus:border-purple-400 rounded-xl px-3 text-center text-sm text-white placeholder:text-white/35 outline-none transition-colors"
          />
          <span className="text-sm font-medium text-white select-none">Hours</span>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !hours}
            className="h-11 px-5 bg-[#20212a] hover:bg-[#282935] border border-white/10 rounded-xl text-xs font-semibold uppercase tracking-wider text-white transition-all active:scale-[0.98] disabled:opacity-50 cursor-pointer"
          >
            {saving ? '...' : 'SAVE'}
          </button>
        </div>

        {error && (
          <p className="text-xs text-red-400 text-center mt-2" role="alert">
            {error}
          </p>
        )}

        {/* Active Timer Info (if running) */}
        {currentEndsAt && (
          <div className="mt-5 pt-4 border-t border-white/8 flex items-center justify-between px-2">
            <p className="text-xs text-white/70">
              ⏳ Sleeps in <span className="text-white font-medium tabular-nums">{formatCountdown(new Date(currentEndsAt).getTime() - Date.now())}</span>
            </p>
            <button
              type="button"
              onClick={handleCancel}
              disabled={saving}
              className="text-xs text-red-400 hover:text-red-300 transition-colors"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return 'now'
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
