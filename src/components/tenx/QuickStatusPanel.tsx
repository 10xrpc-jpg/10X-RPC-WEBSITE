// 10X RPC — Quick Status buttons for instant status switching
'use client'
import { useState } from 'react'
import { api } from '@/lib/api-client'
import { DISCORD_STATUSES } from '@/lib/constants'

interface QuickStatusProps {
  currentStatus?: string
  onStatusChange?: (status: string) => void
}

const QUICK_PRESETS: Array<{ status: string; emoji: string; label: string; color: string }> = [
  { status: 'online', emoji: '🟢', label: 'Online', color: 'bg-green-500' },
  { status: 'idle', emoji: '🟡', label: 'Idle', color: 'bg-yellow-500' },
  { status: 'dnd', emoji: '🔴', label: 'DND', color: 'bg-red-500' },
  { status: 'invisible', emoji: '⚫', label: 'Invisible', color: 'bg-gray-500' },
]

const QUICK_CUSTOM_STATUSES: Array<{ emoji: string; text: string }> = [
  { emoji: '🎮', text: 'Playing' },
  { emoji: '💻', text: 'Coding' },
  { emoji: '🎵', text: 'Listening to music' },
  { emoji: '😴', text: 'AFK' },
  { emoji: '📚', text: 'Studying' },
  { emoji: '☕', text: 'Coffee break' },
]

export function QuickStatusPanel({ currentStatus, onStatusChange }: QuickStatusProps) {
  const [saving, setSaving] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)

  const handleStatus = async (status: string) => {
    setSaving(status)
    try {
      await api.setStatus(status)
      onStatusChange?.(status)
      setFeedback(`Status set to ${status}`)
      setTimeout(() => setFeedback(null), 2000)
    } catch (e) {
      console.error(e)
      setFeedback('Failed to set status')
      setTimeout(() => setFeedback(null), 3000)
    } finally {
      setSaving(null)
    }
  }

  const handleCustom = async (emoji: string, text: string) => {
    setSaving(`custom-${text}`)
    try {
      await api.customStatus(emoji, text)
      setFeedback(`Custom status: ${emoji} ${text}`)
      setTimeout(() => setFeedback(null), 2000)
    } catch (e) {
      console.error(e)
      setFeedback('Failed to set custom status')
      setTimeout(() => setFeedback(null), 3000)
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="glass-card-inner p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-purple-400 font-semibold">Quick Status</span>
        {feedback && (
          <span className="text-[10px] text-green-400">{feedback}</span>
        )}
      </div>

      {/* Discord status pills */}
      <div className="grid grid-cols-4 gap-2">
        {QUICK_PRESETS.map(p => {
          const active = currentStatus === p.status
          return (
            <button
              key={p.status}
              onClick={() => handleStatus(p.status)}
              disabled={saving !== null}
              className={`flex flex-col items-center gap-1 py-2 rounded-lg text-[10px] font-medium transition-all ${
                active
                  ? 'bg-purple-500/20 ring-2 ring-purple-500/50 text-white'
                  : 'bg-[#13141a] border border-white/8 text-white/70 hover:bg-white/5'
              } disabled:opacity-50`}
            >
              <span className={`w-3 h-3 rounded-full ${p.color}`} />
              {p.label}
            </button>
          )
        })}
      </div>

      {/* Custom status quick presets */}
      <div>
        <span className="text-[10px] uppercase tracking-wider text-white/40 font-semibold block mb-1.5">Custom Status</span>
        <div className="grid grid-cols-3 gap-1.5">
          {QUICK_CUSTOM_STATUSES.map(c => (
            <button
              key={c.text}
              onClick={() => handleCustom(c.emoji, c.text)}
              disabled={saving !== null}
              className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-[#13141a] border border-white/8 text-xs text-white hover:bg-white/5 transition-colors disabled:opacity-50"
            >
              <span>{c.emoji}</span>
              <span className="truncate">{c.text}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
